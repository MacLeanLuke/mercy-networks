import { z } from "zod";

export const searchFilterSchema = z.object({
  textQuery: z.string().max(200).default(""),
  populations: z
    .array(z.string().trim().min(1).max(100))
    .max(10)
    .default([]),
  genderRestriction: z.string().trim().min(1).nullable().optional(),
  locations: z
    .array(z.string().trim().min(1).max(100))
    .max(10)
    .default([]),
  requirementsInclude: z
    .array(z.string().trim().min(1).max(100))
    .max(10)
    .default([]),
});

export type SearchFilter = z.infer<typeof searchFilterSchema>;

export const searchInterpretationPrompt = `You are an assistant helping caseworkers find eligibility information for homeless-services and housing programs. The user provides a natural language query describing who they are trying to help. Extract the key search filters:

- textQuery: a concise text phrase capturing the main concept (city, program type, etc.)
- populations: array of population keywords (single adults, families, youth, veterans, seniors, women, men, etc.)
- genderRestriction: if the user implies a gender restriction, choose one of: any, women_only, men_only, non_male, non_female.
- locations: list of geographic hints (city, county, state).
- requirementsInclude: array of important requirements or conditions (e.g., "low barrier", "no sobriety requirement", "accepts teen boys", "income limit").

If the user does not mention a field, leave it empty (for arrays) or null (for genderRestriction). Base everything only on the query text.`;

export function normalizeSearchFilters(
  input: Partial<z.infer<typeof searchFilterSchema>>,
  query: string,
): SearchFilter {
  const list = (value?: string[]) =>
    Array.isArray(value)
      ? value
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];

  const text =
    typeof input.textQuery === "string" && input.textQuery.trim().length > 0
      ? input.textQuery.trim()
      : query;

  return {
    textQuery: text,
    populations: list(input.populations),
    genderRestriction:
      typeof input.genderRestriction === "string" &&
      input.genderRestriction.trim().length > 0
        ? input.genderRestriction.trim()
        : null,
    locations: list(input.locations),
    requirementsInclude: list(input.requirementsInclude),
  };
}
