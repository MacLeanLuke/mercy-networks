import type { Eligibility } from "../lib/eligibility-schema";
import type { CaseResult, FieldResult, Report, SetScore } from "./types";

/**
 * Scoring is deliberately deterministic — no model grades another model's work.
 * An eval you cannot trust is worse than no eval, and an LLM judge introduces
 * exactly the variance the harness exists to measure.
 */

export function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Set F1. Both sides empty scores 1.0 — most documents legitimately state no
 * requirements, and treating that as a failure would swamp the signal.
 * Inventing entries the document never mentioned drives precision to 0, which
 * is how this harness catches over-extraction.
 */
function unique(items: string[]): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const item of items) {
    if (!seen[item]) {
      seen[item] = true;
      out.push(item);
    }
  }
  return out;
}

export function scoreSet(expected: string[], actual: string[]): SetScore {
  const expectedList = unique(expected.map(normalize));
  const actualList = unique(actual.map(normalize));

  const truePositives = actualList.filter((item) => expectedList.indexOf(item) !== -1).length;
  const falsePositives = actualList.length - truePositives;
  const falseNegatives = expectedList.length - truePositives;

  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1, truePositives, falsePositives, falseNegatives };
}

/** Null-aware exact match. Strings compare normalized; everything else strictly. */
export function scoreScalar(expected: unknown, actual: unknown): number {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined ? 1 : 0;
  }
  if (actual === null || actual === undefined) return 0;
  if (typeof expected === "string" && typeof actual === "string") {
    return normalize(expected) === normalize(actual) ? 1 : 0;
  }
  return expected === actual ? 1 : 0;
}

/**
 * Hallucination check: the model is told to quote the passage stating
 * eligibility, so that quote must actually exist in the source. Compared on
 * normalized whitespace because extractors routinely reflow line breaks.
 */
export function isGrounded(span: string, source: string): boolean {
  const needle = normalize(span);
  if (needle.length === 0) return false;
  return normalize(source).includes(needle);
}

export function scoreCase(
  slug: string,
  description: string,
  expected: Eligibility,
  actual: Eligibility,
  source: string,
): CaseResult {
  const fields: FieldResult[] = [];

  const pushSet = (field: string, exp: string[], act: string[]) => {
    const detail = scoreSet(exp, act);
    fields.push({ field, kind: "set", score: detail.f1, expected: exp, actual: act, detail });
  };

  const pushScalar = (field: string, exp: unknown, act: unknown) => {
    fields.push({ field, kind: "scalar", score: scoreScalar(exp, act), expected: exp, actual: act });
  };

  pushScalar("programName", expected.programName, actual.programName);
  pushSet("population", expected.population, actual.population);
  pushScalar("genderRestriction", expected.genderRestriction, actual.genderRestriction);
  pushSet("requirements", expected.requirements, actual.requirements);
  pushSet("locationConstraints", expected.locationConstraints, actual.locationConstraints);
  pushScalar("maxStayDays", expected.maxStayDays, actual.maxStayDays);
  pushScalar("ageRange.min", expected.ageRange?.min ?? null, actual.ageRange?.min ?? null);
  pushScalar("ageRange.max", expected.ageRange?.max ?? null, actual.ageRange?.max ?? null);

  // Two different correct behaviours depending on the document. When the source
  // states eligibility, the quote must be verbatim. When it states none, the
  // only correct answer is to quote nothing — so an empty span scores 1 and any
  // quote at all is a fabrication.
  const actualSpan = actual.rawEligibilityText ?? "";
  const sourceStatesEligibility = (expected.rawEligibilityText ?? "").length > 0;
  const grounded = sourceStatesEligibility
    ? isGrounded(actualSpan, source)
    : actualSpan.trim().length === 0;

  fields.push({
    field: "rawEligibilityText.grounded",
    kind: "grounding",
    score: grounded ? 1 : 0,
    expected: sourceStatesEligibility ? "verbatim span from source" : "no quote (document states no eligibility)",
    actual: grounded
      ? sourceStatesEligibility
        ? "found in source"
        : "correctly declined to quote"
      : sourceStatesEligibility
        ? "NOT found in source"
        : `FABRICATED: ${JSON.stringify(actualSpan.slice(0, 60))}`,
  });

  const score = fields.reduce((sum, f) => sum + f.score, 0) / fields.length;
  return { slug, description, fields, score, grounded };
}

export function aggregate(cases: CaseResult[], model: string, durationMs: number): Report {
  const scored = cases.filter((c) => !c.error);

  const byField: Record<string, number> = {};
  if (scored.length > 0) {
    for (const field of scored[0]!.fields.map((f) => f.field)) {
      const values = scored
        .map((c) => c.fields.find((f) => f.field === field)?.score)
        .filter((v): v is number => typeof v === "number");
      byField[field] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  }

  const allFieldScores = scored.flatMap((c) => c.fields.map((f) => f.score));
  const overall = allFieldScores.length === 0 ? 0 : allFieldScores.reduce((a, b) => a + b, 0) / allFieldScores.length;
  const groundingRate = scored.length === 0 ? 0 : scored.filter((c) => c.grounded).length / scored.length;

  return { cases, overall, byField, groundingRate, model, durationMs };
}

export function formatReport(report: Report): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push("");
  lines.push(`Eligibility extraction eval — ${report.model}`);
  lines.push("=".repeat(58));
  lines.push("");
  lines.push(`  Overall field accuracy   ${pct(report.overall)}`);
  lines.push(`  Grounding rate           ${pct(report.groundingRate)}`);
  lines.push(`  Cases                    ${report.cases.length}`);
  lines.push(`  Duration                 ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("  By field");
  lines.push("  " + "-".repeat(46));
  for (const [field, score] of Object.entries(report.byField).sort((a, b) => a[1] - b[1])) {
    const bar = "█".repeat(Math.round(score * 20)).padEnd(20, "·");
    lines.push(`  ${field.padEnd(28)} ${bar} ${pct(score)}`);
  }
  lines.push("");
  lines.push("  By case");
  lines.push("  " + "-".repeat(46));
  for (const c of report.cases) {
    if (c.error) {
      lines.push(`  ✗ ${c.slug.padEnd(30)} ERROR: ${c.error}`);
      continue;
    }
    const flag = c.score === 1 ? "✓" : c.score >= 0.8 ? "~" : "✗";
    lines.push(`  ${flag} ${c.slug.padEnd(30)} ${pct(c.score)}${c.grounded ? "" : "   [ungrounded quote]"}`);
    for (const f of c.fields.filter((f) => f.score < 1)) {
      lines.push(`      ${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
