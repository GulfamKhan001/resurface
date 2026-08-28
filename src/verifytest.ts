import { verifyItem, verifyAll } from "./verify.ts";
import { validateExtraction, parseJsonLoose } from "./schema.ts";
import type { ExtractedItem } from "./schema.ts";

// Adversarial tests for the two things standing between the model and storage.
//
// A grounding check that never rejects anything is indistinguishable from no
// grounding check at all — the same trap as a chaos harness whose dangerous path
// never executes. So these cases are chosen to FAIL if the checks are hollow.

const SOURCE =
  "We talked about the rule of three: dont generalize code until you have seen the same pattern three times. " +
  "Later we discussed deleting as much code as you can, and reading your dependencies source code.";

const item = (o: Partial<ExtractedItem>): ExtractedItem => ({
  kind: "idea", title: "Some Title", detail: "d", quote: "q", confidence: 0.9, ...o,
} as ExtractedItem);

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

console.log("grounding\n");

const verbatim = verifyItem(item({ quote: "dont generalize code until you have seen the same pattern three times" }), SOURCE);
check("verbatim quote grounds as exact", verbatim.grounding === "exact", `trust ${verbatim.trust}`);

const para = verifyItem(item({ quote: "do not generalize your code until you have seen the same pattern three separate times" }), SOURCE);
check("paraphrase grounds as fuzzy, not exact", para.grounding === "fuzzy", para.reason);

const fake = verifyItem(item({ kind: "book", title: "Clean Code", quote: "functions should be no longer than twenty lines", confidence: 0.99 }), SOURCE);
check("outright fabrication is rejected", fake.grounding === "not_found", `trust ${fake.trust}`);

// The important one: a lie that reads like the truth.
const nearMiss = verifyItem(item({ quote: "wait until you have seen the pattern five times before generalizing" }), SOURCE);
check("plausible near-miss is rejected", nearMiss.grounding === "not_found", nearMiss.reason);

// Confidence must never be able to rescue an ungrounded claim.
const confidentLie = verifyItem(item({ quote: "this sentence does not appear anywhere", confidence: 1 }), SOURCE);
check("model confidence cannot raise trust above the evidence", confidentLie.trust === 0, `trust ${confidentLie.trust} at confidence 1.0`);

const hedgedTruth = verifyItem(item({ quote: "deleting as much code as you can", confidence: 0.2 }), SOURCE);
check("low confidence on a grounded quote still keeps it", hedgedTruth.grounding === "exact" && hedgedTruth.trust > 0, `trust ${hedgedTruth.trust}`);
check("but hedging does lower trust", hedgedTruth.trust < verbatim.trust, `${hedgedTruth.trust} < ${verbatim.trust}`);

const report = verifyAll([verbatim, para, fake, nearMiss], SOURCE);
check("report counts discards", report.discarded.length === 2 && report.hallucinationRate === 50, `${report.hallucinationRate}%`);

console.log("\nschema\n");

const good = validateExtraction(parseJsonLoose('[{"kind":"book","title":"Dune","detail":"recommended","quote":"you should read Dune","confidence":0.8}]'));
check("valid item accepted", good.items.length === 1 && good.rejected.length === 0);

const fenced = validateExtraction(parseJsonLoose('Here you go:\n```json\n[{"kind":"idea","title":"Some Idea","detail":"y","quote":"a real quote here","confidence":0.5}]\n```\nHope that helps!'));
check("fenced JSON wrapped in prose is parsed", fenced.items.length === 1, `${fenced.rejected.length} rejected`);

const badKind = validateExtraction([{ kind: "sandwich", title: "Some Idea", detail: "y", quote: "a real quote here", confidence: 0.5 }]);
check("unknown kind rejected", badKind.items.length === 0 && /kind not one of/.test(badKind.rejected[0].reason));

const noQuote = validateExtraction([{ kind: "idea", title: "Some Idea", detail: "y", confidence: 0.5 }]);
check("item without a quote rejected", noQuote.items.length === 0, noQuote.rejected[0]?.reason);

const badConf = validateExtraction([{ kind: "idea", title: "Some Idea", detail: "y", quote: "a real quote here", confidence: 95 }]);
check("confidence outside 0-1 rejected, not clamped", badConf.items.length === 0, badConf.rejected[0]?.reason);

const strConf = validateExtraction([{ kind: "idea", title: "Some Idea", detail: "y", quote: "a real quote here", confidence: "0.7" }]);
check("numeric string confidence accepted", strConf.items.length === 1);

check("garbage returns no items and says why", validateExtraction(parseJsonLoose("I could not find anything")).rejected.length === 1);

console.log(`\n${failures === 0 ? "ALL CHECKS HELD" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
