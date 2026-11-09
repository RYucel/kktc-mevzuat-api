/**
 * Global circuit breaker: one Durable Object counts the requests that reach
 * D1 across the whole Worker, per minute. Above the limit the API answers 503
 * until the next minute.
 *
 * The per-client rate limit (RATE_LIMITER) stops one noisy client; it cannot
 * stop many clients at once (a botnet of 1,000 addresses at 30 requests a
 * minute each is 43 million requests a day). This gate bounds the total, and
 * with it the bill: at the default 100 requests a minute and ~5,000 D1 rows
 * per question, a month of saturated traffic is ~21 billion rows, inside the
 * 25 billion included in Workers Paid.
 *
 * Classic fetch-style Durable Object (no runtime imports), so it also runs in
 * the plain Node tests.
 */

export const DEFAULT_GATE_PER_MINUTE = 100;

export interface GateDecision {
  allowed: boolean;
  /** Seconds until the window resets (when not allowed). */
  retryAfter: number;
  count: number;
}

/** Fixed one-minute window. Pure, so it can be tested without a runtime. */
export class MinuteWindow {
  private window = -1;
  private count = 0;

  take(limit: number, now = Date.now()): GateDecision {
    const minute = Math.floor(now / 60_000);
    if (minute !== this.window) {
      this.window = minute;
      this.count = 0;
    }
    this.count += 1;
    if (this.count <= limit) return { allowed: true, retryAfter: 0, count: this.count };
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)), count: this.count };
  }
}

/**
 * The single counter. In-memory state is enough: Durable Object instances
 * stay resident while requests keep arriving, and an eviction only resets the
 * current minute.
 */
export class TrafficGate {
  private readonly windowCounter = new MinuteWindow();

  async fetch(request: Request): Promise<Response> {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? DEFAULT_GATE_PER_MINUTE);
    return Response.json(this.windowCounter.take(limit > 0 ? limit : DEFAULT_GATE_PER_MINUTE));
  }
}

/** Paths that never reach D1 (or are our own authenticated jobs). */
export function gateExempt(path: string): boolean {
  return (
    path === "/" ||
    path === "/health" ||
    path === "/llms.txt" ||
    path === "/openapi.json" ||
    path === "/favicon.ico" ||
    path.startsWith("/admin/")
  );
}

// Per isolate: once the gate says "closed until T", answer locally until T so
// a flood does not turn into a flood of Durable Object calls as well.
let closedUntil = 0;

export async function passGate(
  gate: DurableObjectNamespace | undefined,
  limit: number,
  now = Date.now(),
): Promise<GateDecision> {
  if (!gate) return { allowed: true, retryAfter: 0, count: 0 };
  if (now < closedUntil) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((closedUntil - now) / 1000)), count: -1 };
  }
  try {
    const stub = gate.get(gate.idFromName("global"));
    const response = await stub.fetch(`https://gate/take?limit=${limit}`);
    const decision = (await response.json()) as GateDecision;
    if (!decision.allowed) closedUntil = now + decision.retryAfter * 1000;
    return decision;
  } catch (error) {
    // The gate is a cost guard, not a dependency: if it cannot be reached,
    // serve the request (the per-client limit still applies).
    console.warn("traffic gate unavailable:", error instanceof Error ? error.message : error);
    return { allowed: true, retryAfter: 0, count: 0 };
  }
}

/** Test hook. */
export function resetGateCache(): void {
  closedUntil = 0;
}
