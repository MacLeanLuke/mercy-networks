import type { Eligibility } from "../lib/eligibility-schema";

/** A labeled document: the source text plus the extraction we expect from it. */
export interface Fixture {
  /** Directory name under evals/fixtures. */
  slug: string;
  /** What this case is meant to exercise, shown in the report. */
  description: string;
  source: string;
  expected: Eligibility;
}

export interface SetScore {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/** Which scoring rule applies to a field. */
export type FieldKind = "set" | "scalar" | "grounding";

export interface FieldResult {
  field: string;
  kind: FieldKind;
  /** 1 for a correct scalar, the F1 for a set, 1 for a grounded span. */
  score: number;
  expected: unknown;
  actual: unknown;
  detail?: SetScore;
}

export interface CaseResult {
  slug: string;
  description: string;
  fields: FieldResult[];
  /** Mean of field scores for this document. */
  score: number;
  /** True when rawEligibilityText was found verbatim in the source. */
  grounded: boolean;
  error?: string;
}

export interface Report {
  cases: CaseResult[];
  /** Mean field score across every field of every case. */
  overall: number;
  /** Per-field mean across cases, so you can see which field is weakest. */
  byField: Record<string, number>;
  /** Share of cases whose quoted span actually appears in the source. */
  groundingRate: number;
  model: string;
  durationMs: number;
}
