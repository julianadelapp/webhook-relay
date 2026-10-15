import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deliver, isRetryable } from "./deliver.js";
import { Relay, validateConfig, type RelayConfig } from "./relay.js";
import { hmacHex } from "./verify.js";

const noSleep = async () => undefined;
const base = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
const close = (s: Server) => new Promise((r) => s.close(r));

interface Hit {
  body: string;
  headers: IncomingMessage["headers"];
}

/** A target that records requests and answers with the next status in `statuses` (last one repeats). */
function target(statuses: number[]) {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ body: Buffer.concat(chunks).toString(), headers: req.headers });
    const status = statuses[Math.min(hits.length - 1, statuses.length - 1)] as number;
    res.writeHead(status).end();
  });
  return { server, hits };
}

async function withRelay(config: RelayConfig, fn: (relayUrl: string, relay: Relay) => Promise<void>) {
  const relay = new Relay({ ...config, deliver: { attempts: 3, baseDelayMs: 1, sleep: noSleep } });
  const server = relay.createServer();
  await listen(server);
  try {
    await fn(base(server), relay);
  } finally {
    await close(server);
  }
}

test("isRetryable classifies statuses", () => {
  assert.deepEqual([200, 400, 404, 408, 429, 500, 503].map(isRetryable), [false, false, false, true, true, true, true]);
});

test("deliver retries 5xx then succeeds", async () => {
  const t = target([500, 502, 200]);
  await listen(t.server);
  const r = await deliver(base(t.server), Buffer.from("x"), {}, { attempts: 4, sleep: noSleep });
  await close(t.server);
  assert.deepEqual([r.ok, r.attempts, t.hits.length], [true, 3, 3]);
});

test("deliver does not retry permanent 4xx", async () => {
  const t = target([404]);
  await listen(t.server);
  const r = await deliver(base(t.server), Buffer.from("x"), {}, { attempts: 4, sleep: noSleep });
  await close(t.server);
  assert.deepEqual([r.ok, r.attempts], [false, 1]);
});

test("validateConfig fails closed", () => {
  assert.throws(() => validateConfig({ routes: { a: { scheme: "github", targets: ["http://x"] } } }), /needs a secret/);
  assert.throws(() => validateConfig({ routes: { a: { scheme: "none", targets: ["ftp://x"] } } }), /http\(s\)/);
  assert.throws(() => validateConfig({ routes: { a: { scheme: "none", targets: [] } } }), /no targets/);
});

test("valid GitHub webhook fans out to every target with the raw body", async () => {
  const a = target([200]);
  const b = target([200]);
  await Promise.all([listen(a.server), listen(b.server)]);
  const body = JSON.stringify({ zen: "Keep it logically awesome." });
  const config: RelayConfig = { routes: { gh: { scheme: "github", secret: "s3", targets: [base(a.server), base(b.server)] } } };
  await withRelay(config, async (url, relay) => {
    const res = await fetch(`${url}/hooks/gh`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": `sha256=${hmacHex("s3", body)}` },
      body,
    });
    assert.equal(res.status, 202);
    await relay.drain();
  });
  await Promise.all([close(a.server), close(b.server)]);
  assert.equal(a.hits.length, 1);
  assert.equal(b.hits.length, 1);
  assert.equal(a.hits[0]?.body, body);
  assert.equal(a.hits[0]?.headers["x-github-event"], "ping");
  assert.ok(a.hits[0]?.headers["x-relay-delivery"]);
});

test("bad signature is rejected and nothing is forwarded", async () => {
  const a = target([200]);
  await listen(a.server);
  const config: RelayConfig = { routes: { gh: { scheme: "github", secret: "s3", targets: [base(a.server)] } } };
  await withRelay(config, async (url, relay) => {
    const res = await fetch(`${url}/hooks/gh`, { method: "POST", headers: { "x-hub-signature-256": "sha256=00" }, body: "{}" });
    assert.equal(res.status, 401);
    await relay.drain();
  });
  await close(a.server);
  assert.equal(a.hits.length, 0);
});

test("duplicate GitHub delivery ids are accepted once", async () => {
  const a = target([200]);
  await listen(a.server);
  const config: RelayConfig = { routes: { open: { scheme: "none", targets: [base(a.server)] } } };
  await withRelay(config, async (url, relay) => {
    const send = () => fetch(`${url}/hooks/open`, { method: "POST", headers: { "x-github-delivery": "d-1" }, body: "{}" });
    assert.equal((await send()).status, 202);
    const second = await send();
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { status: string }).status, "duplicate");
    await relay.drain();
  });
  await close(a.server);
  assert.equal(a.hits.length, 1);
});

test("failed deliveries land in the dead-letter list behind the admin token", async () => {
  const a = target([500]);
  await listen(a.server);
  const config: RelayConfig = { adminToken: "adm", routes: { open: { scheme: "none", targets: [base(a.server)] } } };
  await withRelay(config, async (url, relay) => {
    await fetch(`${url}/hooks/open`, { method: "POST", body: "{}" });
    await relay.drain();
    assert.equal((await fetch(`${url}/dead-letters`)).status, 401);
    const res = await fetch(`${url}/dead-letters`, { headers: { authorization: "Bearer adm" } });
    const list = (await res.json()) as { attempts: number }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]?.attempts, 3);
  });
  await close(a.server);
});

test("dead-letter endpoint is disabled without an admin token; unknown routes 404", async () => {
  const config: RelayConfig = { routes: { open: { scheme: "none", targets: ["http://127.0.0.1:1"] } } };
  await withRelay(config, async (url) => {
    assert.equal((await fetch(`${url}/dead-letters`)).status, 404);
    assert.equal((await fetch(`${url}/hooks/nope`, { method: "POST", body: "{}" })).status, 404);
  });
});
