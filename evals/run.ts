import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures } from "./fixtures";
import { aggregate, formatReport, scoreCase } from "./scorer";
import type { CaseResult, Report } from "./types";

/**
 * Runs the real extractor against every labeled fixture and scores the output.
 *
 *   npm run eval                      score every case
 *   npm run eval -- --filter=youth    score matching cases only
 *   npm run eval -- --threshold=0.85  exit non-zero below this score
 *   npm run eval -- --save            write evals/baseline.json
 *   npm run eval -- --json            machine-readable output
 *
 * Scoring lives in scorer.ts and is covered by its own unit tests, so a green
 * eval means the extractor improved — not that the scorer drifted.
 */

const BASELINE_PATH = join(process.cwd(), "evals", "baseline.json");
const CONCURRENCY = 4;

function loadEnvLocal(): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key!]) continue;
    process.env[key!] = rawValue!.replace(/^["']|["']$/g, "");
  }
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** Bounded concurrency — enough to keep the run short, low enough to avoid rate limits. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function compareToBaseline(report: Report): void {
  if (!existsSync(BASELINE_PATH)) return;

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Report;
  const delta = report.overall - baseline.overall;
  const sign = delta >= 0 ? "+" : "";
  const arrow = delta > 0.001 ? "improved" : delta < -0.001 ? "REGRESSED" : "unchanged";

  console.log(`  vs baseline (${baseline.model}): ${sign}${(delta * 100).toFixed(1)} pts — ${arrow}`);

  const regressions = Object.entries(report.byField)
    .map(([field, score]) => [field, score - (baseline.byField[field] ?? 0)] as const)
    .filter(([, d]) => d < -0.001)
    .sort((a, b) => a[1] - b[1]);

  for (const [field, d] of regressions) {
    console.log(`    ${field}: ${(d * 100).toFixed(1)} pts`);
  }
  console.log("");
}

async function main(): Promise<void> {
  loadEnvLocal();

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Add it to .env.local or the environment.");
    console.error("The scorer's own tests run without a key: npm test");
    process.exit(2);
  }

  const { extractEligibility } = await import("../lib/eligibility-extractor");

  const fixtures = loadFixtures(arg("filter"));
  if (fixtures.length === 0) {
    console.error("No fixtures matched.");
    process.exit(2);
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4.1";
  const started = Date.now();

  const cases = await mapLimit<(typeof fixtures)[number], CaseResult>(fixtures, CONCURRENCY, async (fixture) => {
    try {
      const actual = await extractEligibility({ text: fixture.source, sourceType: "pdf" });
      return scoreCase(fixture.slug, fixture.description, fixture.expected, actual, fixture.source);
    } catch (error) {
      return {
        slug: fixture.slug,
        description: fixture.description,
        fields: [],
        score: 0,
        grounded: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const report = aggregate(cases, model, Date.now() - started);

  if (hasFlag("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
    compareToBaseline(report);
  }

  if (hasFlag("save")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`  baseline written to evals/baseline.json`);
  }

  const threshold = Number(arg("threshold") ?? "0");
  if (threshold > 0 && report.overall < threshold) {
    console.error(`\nFAIL: ${(report.overall * 100).toFixed(1)}% is below the ${(threshold * 100).toFixed(1)}% threshold.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
