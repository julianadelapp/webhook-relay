import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { deliver, type DeliverOptions } from "./deliver.js";
import { readRawBody, verifyGitHub, verifySlack, verifyStripe, type VerifyResult } from "./verify.js";

export type Scheme = "github" | "stripe" | "slack" | "none";

export interface Route {
  scheme: Scheme;
  /** Required unless scheme is "none". */
  secret?: string;
  targets: string[];
}

export interface RelayConfig {
  routes: Record<string, Route>;
  adminToken?: string;
  deliver?: DeliverOptions;
}

export interface DeadLetter {
  id: string;
  route: string;
  target: string;
  attempts: number;
  error: string;
  at: string;
}

const FORWARDED = [
  "content-type",
  "user-agent",
  "x-github-event",
  "x-github-delivery",
  "x-hub-signature-256",
  "stripe-signature",
  "x-slack-signature",
  "x-slack-request-timestamp",
];

/** Fails closed: a route that is not "none" must have a secret, and every target must be http(s). */
export function validateConfig(config: RelayConfig): void {
  for (const [name, route] of Object.entries(config.routes)) {
    if (route.scheme !== "none" && !route.secret) throw new Error(`route "${name}" needs a secret`);
    if (route.targets.length === 0) throw new Error(`route "${name}" has no targets`);
    for (const t of route.targets) {
      if (!/^https?:\/\//.test(t)) throw new Error(`route "${name}" target must be http(s): ${t}`);
    }
  }
}

function check(route: Route, req: IncomingMessage, body: Buffer): VerifyResult {
  const h = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  switch (route.scheme) {
    case "github":
      return verifyGitHub(route.secret ?? "", body, h("x-hub-signature-256"));
    case "stripe":
      return verifyStripe(route.secret ?? "", body, h("stripe-signature"));
    case "slack":
      return verifySlack(route.secret ?? "", body, h("x-slack-request-timestamp"), h("x-slack-signature"));
    default:
      return { ok: true };
  }
}

export class Relay {
  readonly deadLetters: DeadLetter[] = [];
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly config: RelayConfig) {
    validateConfig(config);
  }

  /** Resolves when all background deliveries have finished (used by tests and graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private dispatch(routeName: string, route: Route, body: Buffer, req: IncomingMessage): void {
    const id = randomUUID();
    const headers: Record<string, string> = { "x-relay-delivery": id, "x-relay-route": routeName };
    for (const name of FORWARDED) {
      const v = req.headers[name];
      if (typeof v === "string") headers[name] = v;
    }
    for (const target of route.targets) {
      const job = deliver(target, body, headers, this.config.deliver).then((result) => {
        if (!result.ok) {
          this.deadLetters.unshift({
            id,
            route: routeName,
            target,
            attempts: result.attempts,
            error: result.error ?? "unknown",
            at: new Date().toISOString(),
          });
          this.deadLetters.length = Math.min(this.deadLetters.length, 200);
        }
      });
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && url.pathname === "/health") return send(200, { status: "ok" });

    if (req.method === "GET" && url.pathname === "/dead-letters") {
      const token = this.config.adminToken;
      const given = Buffer.from(req.headers.authorization ?? "");
      const want = Buffer.from(`Bearer ${token ?? ""}`);
      if (!token) return send(404, { error: "not found" });
      if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: "unauthorized" });
      return send(200, this.deadLetters);
    }

    const match = /^\/hooks\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      const name = match[1] as string;
      const route = this.config.routes[name];
      if (!route) return send(404, { error: "unknown route" });
      const body = await readRawBody(req);
      if (body === null) return send(413, { error: "payload too large" });
      const verdict = check(route, req, body);
      if (!verdict.ok) return send(401, { error: "invalid signature" });
      const delivery = req.headers["x-github-delivery"];
      if (typeof delivery === "string" && !this.remember(`${name}:${delivery}`)) {
        return send(200, { status: "duplicate" });
      }
      this.dispatch(name, route, body, req);
      return send(202, { status: "accepted", targets: route.targets.length });
    }

    return send(404, { error: "not found" });
  }

  createServer(): Server {
    return createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  }
}
