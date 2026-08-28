// Tracing, hand-rolled against the two specs that matter: W3C Trace Context for
// propagation and OTLP/HTTP+JSON for export.
//
// Why not @opentelemetry/sdk-node: it pulls in 13+ packages including three gRPC
// exporters, and its context propagation is built on Node's AsyncLocalStorage.
// The edge tier of this system is a Cloudflare Worker with a 10ms CPU budget and
// no AsyncLocalStorage, so the official SDK cannot run on the half of the system
// where the trace has to START. A tracer that works in one runtime is not a
// distributed tracer.
//
// What that costs: no auto-instrumentation, so every span here is one someone
// decided to create. What it buys: the same ~200 lines run on the edge, in the
// worker, and in a test — and the wire format is the standard one, so this
// exports to Grafana, Honeycomb or anything else that speaks OTLP without
// changing a line.

export interface SpanContext {
  traceId: string;   // 32 hex chars
  spanId: string;    // 16 hex chars
  sampled: boolean;
}

export interface Attributes {
  [k: string]: string | number | boolean | undefined | null;
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startNano: bigint;
  endNano: bigint;
  attributes: Attributes;
  status: { code: number; message?: string };
}

const hex = (bytes: number): string => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const newTraceId = () => hex(16);
export const newSpanId = () => hex(8);

// ─── W3C Trace Context ───
//
// version-traceid-spanid-flags, e.g.
//   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//
// This is the whole of cross-runtime propagation: the edge puts this string
// somewhere the worker will read it, and the worker continues the same trace.
// In this system "somewhere" is a column on the jobs row rather than an HTTP
// header, because the boundary being crossed is a queue, not a request. Same
// spec, different carrier — which is the part worth being able to explain.
export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

export function parseTraceparent(header: string | null | undefined): SpanContext | null {
  if (!header) return null;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim());
  if (!m) return null;
  // All-zero ids are invalid per the spec and mean an upstream bug, not a trace.
  if (/^0+$/.test(m[2]) || /^0+$/.test(m[3])) return null;
  return { traceId: m[2], spanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 };
}

// ─── sampling ───
//
// Head sampling on the trace id, so the decision is stable: every span of a
// trace agrees without needing to coordinate. Errors are forced through
// regardless — a sampled-out failure is the one trace you actually wanted.
function shouldSample(traceId: string): boolean {
  const SAMPLE_RATE = Number(process.env.TRACE_SAMPLE_RATE ?? 1);
  if (SAMPLE_RATE >= 1) return true;
  if (SAMPLE_RATE <= 0) return false;
  // Last 8 hex chars as a uniform value in [0,1).
  return parseInt(traceId.slice(-8), 16) / 0xffffffff < SAMPLE_RATE;
}

// ─── the tracer ───

// Read at call time, not at module load.
//
// These were consts evaluated on import, which meant the collector endpoint was
// fixed before anything could configure it — a test that set the variable after
// importing this module got spans silently dropped, and the module was right to
// drop them because as far as it knew there was no collector. Config captured at
// import time also forces every entry point to set its environment before the
// first import, which is a rule nobody remembers.
const service = () => process.env.OTEL_SERVICE_NAME || "resurface";
const endpoint = () => process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "";
const headerSpec = () => process.env.OTEL_EXPORTER_OTLP_HEADERS || "";

const buffer: FinishedSpan[] = [];

export class Span {
  readonly ctx: SpanContext;
  private readonly parentSpanId?: string;
  private readonly startNano: bigint;
  private attributes: Attributes = {};
  private status: { code: number; message?: string } = { code: 0 };
  private ended = false;
  private name: string;
  private kind: number;

  // Fields declared and assigned explicitly rather than via constructor
  // parameter properties. Node's type stripping removes types; it does not
  // SYNTHESISE code, and `constructor(private name: string)` is shorthand for an
  // assignment that has to be generated. That is the honest cost of running
  // TypeScript with no build step, and it shows up as a runtime
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX rather than a compile error — so tsc alone
  // will not catch it.
  constructor(name: string, parent?: SpanContext | null, attrs: Attributes = {}, kind = 1) {
    this.name = name;
    this.kind = kind;
    const traceId = parent?.traceId ?? newTraceId();
    this.ctx = { traceId, spanId: newSpanId(), sampled: parent?.sampled ?? shouldSample(traceId) };
    this.parentSpanId = parent?.spanId;
    this.startNano = BigInt(Date.now()) * 1_000_000n;
    this.attributes = { ...attrs };
  }

  set(attrs: Attributes): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  /** Money. The reason this project traces at all — see cost.usd in the README. */
  cost(usd: number): this {
    this.attributes["cost.usd"] = Math.round(usd * 1e6) / 1e6;
    return this;
  }

  fail(err: unknown): this {
    this.status = { code: 2, message: String((err as Error)?.message ?? err).slice(0, 300) };
    this.attributes["error"] = true;
    // Force the sample: a trace that failed is the one worth keeping.
    this.ctx.sampled = true;
    return this;
  }

  end(): void {
    if (this.ended) return;      // ending twice would double-count the duration
    this.ended = true;
    if (!this.ctx.sampled) return;
    buffer.push({
      traceId: this.ctx.traceId,
      spanId: this.ctx.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startNano: this.startNano,
      endNano: BigInt(Date.now()) * 1_000_000n,
      attributes: this.attributes,
      status: this.status,
    });
  }
}

export function startSpan(name: string, parent?: SpanContext | null, attrs: Attributes = {}): Span {
  return new Span(name, parent, attrs);
}

/** Run fn inside a span, recording failure and always ending it. */
export async function traced<T>(name: string, parent: SpanContext | null | undefined, attrs: Attributes, fn: (s: Span) => Promise<T>): Promise<T> {
  const span = startSpan(name, parent, attrs);
  try {
    return await fn(span);
  } catch (err) {
    span.fail(err);
    throw err;
  } finally {
    span.end();
  }
}

// ─── OTLP/HTTP export ───

function attrValue(v: string | number | boolean): Record<string, unknown> {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function toAttrs(a: Attributes) {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: attrValue(value as string | number | boolean) }));
}

export function buildPayload(spans: FinishedSpan[]) {
  return {
    resourceSpans: [{
      resource: {
        attributes: toAttrs({
          "service.name": service(),
          "service.version": process.env.npm_package_version || "0.1.0",
          "deployment.environment": process.env.NODE_ENV || "development",
        }),
      },
      scopeSpans: [{
        scope: { name: "resurface/trace.ts", version: "1" },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: s.startNano.toString(),
          endTimeUnixNano: s.endNano.toString(),
          attributes: toAttrs(s.attributes),
          status: s.status,
        })),
      }],
    }],
  };
}

export function pending(): number {
  return buffer.length;
}

export function drain(): FinishedSpan[] {
  return buffer.splice(0, buffer.length);
}

// Export whatever has accumulated. Called at the end of a run rather than on a
// timer, because a worker that scales to zero has no timer to fire — and losing
// the spans for the run that just finished is the common way self-hosted tracing
// silently stops working.
export async function flush(): Promise<{ exported: number; ok: boolean; reason?: string }> {
  const spans = drain();
  if (!spans.length) return { exported: 0, ok: true };
  const ENDPOINT = endpoint();
  if (!ENDPOINT) {
    // No collector configured is a legitimate state, not an error: the tracer is
    // useful locally without one. Say so rather than failing the run.
    return { exported: spans.length, ok: true, reason: "no OTEL_EXPORTER_OTLP_ENDPOINT — spans dropped" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const pair of headerSpec().split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }

  try {
    const res = await fetch(`${ENDPOINT.replace(/\/$/, "")}/v1/traces`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildPayload(spans)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { exported: 0, ok: false, reason: `collector HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
    return { exported: spans.length, ok: true };
  } catch (err) {
    // Never let telemetry take down the thing it is observing.
    return { exported: 0, ok: false, reason: (err as Error).message.slice(0, 120) };
  }
}
