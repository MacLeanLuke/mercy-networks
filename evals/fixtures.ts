import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eligibilitySchema } from "../lib/eligibility-schema";
import type { Fixture } from "./types";

const FIXTURE_DIR = join(process.cwd(), "evals", "fixtures");

/**
 * Labels are parsed through the same Zod schema the extractor targets, so a
 * schema change breaks the fixtures loudly instead of silently scoring against
 * a shape that no longer exists.
 */
export function loadFixtures(filter?: string): Fixture[] {
  const slugs = readdirSync(FIXTURE_DIR)
    .filter((entry) => statSync(join(FIXTURE_DIR, entry)).isDirectory())
    .filter((slug) => !filter || slug.includes(filter))
    .sort();

  return slugs.map((slug) => {
    const dir = join(FIXTURE_DIR, slug);
    const source = readFileSync(join(dir, "source.txt"), "utf8");
    const raw = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as {
      description: string;
      expected: unknown;
    };

    const parsed = eligibilitySchema.safeParse(raw.expected);
    if (!parsed.success) {
      throw new Error(`Fixture "${slug}" does not match eligibilitySchema: ${parsed.error.message}`);
    }

    return { slug, description: raw.description, source, expected: parsed.data };
  });
}
