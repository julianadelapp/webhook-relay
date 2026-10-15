export interface DeliverOptions {
  /** Total attempts including the first (default 4). */
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliverResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 2xx succeeds; 4xx (except 408/429) is permanent; everything else is retried with backoff. */
export function isRetryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export async function deliver(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
  opts: DeliverOptions = {},
): Promise<DeliverResult> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  let last: DeliverResult = { ok: false, attempts: 0 };

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: new Uint8Array(body),
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      await res.arrayBuffer().catch(() => undefined);
      last = { ok: res.ok, attempts: i, status: res.status };
      if (res.ok) return last;
      if (!isRetryable(res.status)) return { ...last, error: `permanent failure (${res.status})` };
      last.error = `HTTP ${res.status}`;
    } catch (err) {
      last = { ok: false, attempts: i, error: err instanceof Error ? err.message : "network error" };
    }
    if (i < attempts) await sleep(base * 2 ** (i - 1));
  }
  return last;
}
