import { runEvals, loadBaseline, saveBaseline, compare } from "./evals.ts";
import { close } from "./db.ts";

// npm run eval             -- score against the hand-labelled set
// npm run eval -- --save   -- also write the regression baseline
const save = process.argv.includes("--save");

const run = await runEvals({ stability: true });
const t = run.totals;

console.log(`\n  prompt ${run.promptVersion}\n`);
for (const c of run.cases) {
  const mark = c.trapsHit.length ? "TRAP" : c.recall === 1 ? "ok  " : "MISS";
  console.log(`  ${mark}  ${c.id.padEnd(22)} recall ${c.matched}/${c.expected}  extracted ${c.extracted} (grounded ${c.grounded})${c.trapsHit.length ? `  hit: ${c.trapsHit.join(", ")}` : ""}`);
  for (const i of c.items) console.log(`          ${String(i.trust).padStart(5)} ${i.kind.padEnd(8)} ${i.title.slice(0, 54)}`);
}

console.log(`\n  recall            ${t.recall}   (${t.matched}/${t.expected} labelled items found)`);
console.log(`  trap avoidance    ${t.trapAvoidance}   (${t.traps - t.trapsHit}/${t.traps} traps avoided)`);
console.log(`  hallucination     ${t.hallucinationRate}%  (ungrounded, discarded before storage)`);
// Printed even when zero. A metric that only appears when it is bad is a metric
// nobody builds a habit of reading.
console.log(`  detail mentions   ${run.totals.detailMentions}   (rejected things named in a detail — context, not a recommendation; not scored)`);
if (run.stability) console.log(`  self-agreement    ${run.stability.agreement}   (same input twice, ${run.stability.casesRun} cases)`);
console.log(`  cost              $${t.usd.toFixed(4)} over ${t.calls} calls`);

const base = loadBaseline();
if (base) {
  const c = compare(run, base);
  console.log(`\n  vs baseline (${base.promptVersion}${c.promptChanged ? " — PROMPT CHANGED" : " — same prompt"}):`);
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  console.log(`    recall ${sign(c.recall)}   trap avoidance ${sign(c.trapAvoidance)}   hallucination ${sign(c.hallucinationRate)}pp   cost ${sign(c.usd)}`);
  if (c.perCase.length) {
    console.log(`    moved:`);
    for (const p of c.perCase) console.log(`      ${p.id.padEnd(22)} recall ${sign(p.recall)}  traps ${sign(p.traps)}${"isNew" in p ? "  (new case)" : ""}`);
  } else {
    console.log(`    no case changed`);
  }
} else {
  console.log(`\n  no baseline yet — run with --save to record one`);
}

if (save) { saveBaseline(run); console.log(`\n  baseline written`); }
await close();
