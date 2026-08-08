import { z } from "zod";

export const populationOptions = [
  "single_adults",
  "families",
  "youth",
  "veterans",
  "seniors",
  "any",
] as const;

export const genderRestrictions = [
  "any",
  "women_only",
  "men_only",
  "non_male",
  "non_female",
] as const;

export const requirementOptions = [
  "sober",
  "id_required",
  "background_check",
  "income_limit",
  "must_be_resident",
  "must_be_veteran",
  "must_have_child",
] as const;

export const eligibilitySchema = z.object({
  programName: z
    .union([z.string().trim().min(1), z.null()])
    .transform((value) => (value === null ? null : value.trim()))
    .default(null),
  // Intentionally allows "". Requiring text here meant a document stating no
  // eligibility rules (an annual report, a donor letter) had no valid answer, so
  // the model had to invent a quote to satisfy the schema. Surfaced by
  // evals/fixtures/no-eligibility-stated.
  rawEligibilityText: z.string().default(""),
  population: z.array(z.enum(populationOptions)).default([]),
  genderRestriction: z
    .enum(genderRestrictions)
    .nullish()
    .transform((value): (typeof genderRestrictions)[number] => value ?? "any"),
  requirements: z.array(z.enum(requirementOptions)).default([]),
  locationConstraints: z.array(z.string().trim().min(1)).default([]),
  maxStayDays: z.number().int().nonnegative().nullable().default(null),
  ageRange: z
    .union([
      z.object({
        min: z.number().int().nonnegative().nullable().default(null),
        max: z.number().int().nonnegative().nullable().default(null),
      }),
      z.null(),
    ])
    .transform((value) => value ?? { min: null, max: null })
    .default({ min: null, max: null }),
  notes: z.string().default(""),
});

export type Eligibility = z.infer<typeof eligibilitySchema>;

export const eligibilitySystemPrompt = `You are an expert case manager who extracts structured eligibility rules from materials describing homeless-services and housing programs. Inputs may include PDF documents or website pages. Use only information explicitly stated in the provided content. If any field is not mentioned, return null for single values or [] for arrays. For genderRestriction, use "any" when no restriction is stated. Do not infer beyond the text. Provide the exact excerpt that states eligibility in rawEligibilityText, copied verbatim from the input. If the content states no eligibility rules at all, return an empty string for rawEligibilityText rather than quoting unrelated text — an empty answer is correct and strongly preferred over an invented one.`;
