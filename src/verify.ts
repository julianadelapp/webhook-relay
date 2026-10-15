// Vendored from webhook-verify (https://github.com/julianadelapp/webhook-verify) so this repo has no dependencies.
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const ok: VerifyResult = { ok: true };
const fail = (reason: string): VerifyResult => ({ ok: false, reason });

export interface TimestampOptions {
  /** Maximum allowed clock difference in seconds (default 300). */
  toleranceSeconds?: number;
  /** Current time in epoch seconds. Injectable for tests. */
  now?: number;
}

/** Constant-time string comparison. Different lengths never match. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacHex(secret: string, payload: string | Buffer, algorithm = "sha256"): string {
  return createHmac(algorithm, secret).update(payload).digest("hex");
}

function withinTolerance(timestamp: string, opts: TimestampOptions): VerifyResult {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || ts <= 0) return fail("invalid timestamp");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return fail("timestamp outside tolerance");
  return ok;
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export function verifyGitHub(secret: string, rawBody: string | Buffer, header: string | undefined): VerifyResult {
  if (!secret) return fail("missing secret");
  if (!header || !header.startsWith("sha256=")) return fail("missing or malformed signature header");
  return safeEqual(`sha256=${hmacHex(secret, rawBody)}`, header) ? ok : fail("signature mismatch");
}

/**
 * Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`, signed over `${t}.${body}`.
 * Several v1 values can be present during secret rotation; any match is accepted.
 */
export function verifyStripe(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
  opts: TimestampOptions = {},
): VerifyResult {
  if (!secret) return fail("missing secret");
  if (!header) return fail("missing signature header");
  let timestamp = "";
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) candidates.push(value);
  }
  if (!timestamp || candidates.length === 0) return fail("malformed signature header");
  const fresh = withinTolerance(timestamp, opts);
  if (!fresh.ok) return fresh;
  const expected = hmacHex(secret, `${timestamp}.${rawBody.toString()}`);
  return candidates.some((c) => safeEqual(expected, c)) ? ok : fail("signature mismatch");
}

/** Slack: `X-Slack-Signature: v0=<hex>` over `v0:${X-Slack-Request-Timestamp}:${body}`. */
export function verifySlack(
  secret: string,
  rawBody: string | Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  opts: TimestampOptions = {},
): VerifyResult {
  if (!secret) return fail("missing secret");
  if (!timestamp || !signature || !signature.startsWith("v0=")) return fail("missing or malformed headers");
  const fresh = withinTolerance(timestamp, opts);
  if (!fresh.ok) return fresh;
  const expected = `v0=${hmacHex(secret, `v0:${timestamp}:${rawBody.toString()}`)}`;
  return safeEqual(expected, signature) ? ok : fail("signature mismatch");
}

/** Reads a request body as raw bytes (signatures must be checked before any JSON parsing). */
export async function readRawBody(
  req: AsyncIterable<Buffer | string>,
  limitBytes = 1_048_576,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > limitBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
