import { createServer } from "node:http";
import { pool, close } from "./db.ts";
import { startSpan, traced, flush, formatTraceparent, parseTraceparent, pending } from "./trace.ts";

// Prove the tracing actually works, without needing a Grafana account.
//
// A local OTLP receiver stands in for the collector: it speaks the same
// protocol, so if spans arrive here correctly shaped they will arrive at Grafana
// correctly shaped. The alternative — assuming the wire format is right because
// the code looks right — is how self-hosted tracing gets shipped broken.
//
// The two properties that matter, and that a single-process test could fake:
//   1. one user action produces ONE trace, not several
//   2. the trace survives the queue boundary, where there is no HTTP header

interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status?: { code?: number };
}

const received: OtlpSpan[] = [];

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/v1/traces")) { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const p = JSON.parse(body);
      for (const rs of p.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) received.push(...(ss.spans ?? []));
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
  });
});

const attr = (s: OtlpSpan, k: string): unknown => {
  const a = s.attributes.find((x) => x.key === k);
  if (!a) return undefined;
  const v = a.value as Record<string, string>;
  return v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue;
};

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  await new Promise<void>((r) => server.listen(4318, r));
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
  console.log("local OTLP receiver on :4318\n");

  // ── Act 1: the edge accepts a link and enqueues. Trace starts here. ──
  const edge = startSpan("edge.accept", null, { "http.route": "/save", "runtime": "cloudflare-worker" });
  const traceparent = formatTraceparent(edge.ctx);
  await traced("edge.enqueue", edge.ctx, { "runtime": "cloudflare-worker" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  edge.end();

  // The edge is now GONE. Everything it held in memory is unavailable — this is
  // the boundary a single-process test would accidentally paper over.
  const carried = traceparent;

  // ── Act 2: minutes later, a different runtime picks the row up. ──
  const parent = parseTraceparent(carried);
  check("worker parsed the traceparent off the row", parent !== null);
  if (!parent) { await finish(); return; }

  const worker = startSpan("worker.process", parent, { "runtime": "cloud-run" });
  await traced("source.fetch", worker.ctx, { "source.tier": "page_text" }, async (s) => {
    await new Promise((r) => setTimeout(r, 8));
    s.cost(0);                       // the free tier, recorded as zero rather than omitted
  });
  for (let i = 0; i < 3; i++) {
    await traced("extract.chunk", worker.ctx, { "chunk.idx": i }, async (s) => {
      await new Promise((r) => setTimeout(r, 4));
      s.cost(0.0054);
    });
  }
  await traced("verify.grounding", worker.ctx, { "grounding.hallucination_rate": 0 }, async () => {
    await new Promise((r) => setTimeout(r, 2));
  });
  worker.set({ "items.kept": 12 }).cost(0.0162);
  worker.end();

  // A failure must survive sampling and be visible as one.
  await traced("extract.chunk", worker.ctx, { "chunk.idx": 99 }, async () => {
    throw new Error("simulated provider timeout");
  }).catch(() => {});

  console.log(`  ${pending()} spans buffered`);
  const f = await flush();
  console.log(`  flush: exported ${f.exported}${f.reason ? ` (${f.reason})` : ""}\n`);
  await new Promise((r) => setTimeout(r, 120));   // let the receiver finish

  await finish();
}

async function finish() {
  // ── assertions on what the collector actually received ──
  const traces = new Set(received.map((s) => s.traceId));
  check("every span landed in ONE trace", traces.size === 1, `${received.length} spans, ${traces.size} trace id(s)`);

  const byId = new Map(received.map((s) => [s.spanId, s]));
  const roots = received.filter((s) => !s.parentSpanId || !byId.has(s.parentSpanId));
  check("the tree has a single root", roots.length === 1, roots.map((r) => r.name).join(", "));

  const workerSpan = received.find((s) => s.name === "worker.process");
  const edgeSpan = received.find((s) => s.name === "edge.accept");
  check(
    "the worker span is a CHILD of the edge span — the boundary was crossed",
    !!workerSpan && !!edgeSpan && workerSpan.parentSpanId === edgeSpan.spanId,
    workerSpan ? `parent ${workerSpan.parentSpanId} vs edge ${edgeSpan?.spanId}` : "worker span missing"
  );

  const costs = received.map((s) => Number(attr(s, "cost.usd") ?? 0));
  const chunkCost = received.filter((s) => s.name === "extract.chunk").reduce((n, s) => n + Number(attr(s, "cost.usd") ?? 0), 0);
  check("money is on the spans", costs.some((c) => c > 0), `chunk spans total $${chunkCost.toFixed(4)}`);

  const failed = received.filter((s) => s.status?.code === 2);
  check("the failing span is marked and kept", failed.length === 1, failed.map((s) => s.name).join(","));

  // `every` on an empty array is true, so without the length guard this check
  // passed while zero spans had been received — reporting "max -Infinityms" and
  // still calling itself a PASS. A vacuous assertion is worse than no assertion:
  // it actively tells you the thing it did not test is fine.
  const durations = received.map((s) => Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6);
  check(
    "durations are positive and plausible",
    durations.length > 0 && durations.every((d) => d >= 0 && d < 60_000),
    durations.length ? `max ${Math.max(...durations).toFixed(1)}ms over ${durations.length} spans` : "NO SPANS RECEIVED"
  );

  // ── the trace, as a human would read it ──
  console.log("\n  the trace:\n");
  const children = (id?: string) => received.filter((s) => s.parentSpanId === id).sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
  const draw = (s: OtlpSpan, depth: number) => {
    const ms = (Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6).toFixed(0);
    const cost = Number(attr(s, "cost.usd") ?? 0);
    const rt = attr(s, "runtime");
    const err = s.status?.code === 2 ? "  ERROR" : "";
    console.log(`  ${"  ".repeat(depth)}${depth ? "└ " : ""}${s.name.padEnd(22 - depth * 2)} ${ms.padStart(5)}ms  ${cost ? "$" + cost.toFixed(4) : "     —"}  ${rt ?? ""}${err}`);
    for (const c of children(s.spanId)) draw(c, depth + 1);
  };
  for (const r of received.filter((s) => !s.parentSpanId || !new Map(received.map((x) => [x.spanId, x])).has(s.parentSpanId))) draw(r, 0);

  const total = received.reduce((n, s) => n + Number(attr(s, "cost.usd") ?? 0), 0);
  console.log(`\n  total attributed cost across the trace: $${total.toFixed(4)}`);
  console.log(`\n  ${failures === 0 ? "TRACING HOLDS" : `${failures} FAILURES`}`);

  server.close();
  await close().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("tracetest crashed:", e);
  server.close();
  await close().catch(() => {});
  process.exit(1);
});
