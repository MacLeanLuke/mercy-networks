import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { eligibilityDocuments } from "@/db/schema";
import type { Eligibility } from "@/lib/eligibility-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  query: z.string().trim().min(1, "Query is required."),
  limit: z.number().int().positive().max(50).optional(),
  filters: z
    .object({
      locationCity: z.string().trim().min(1).optional(),
      locationCounty: z.string().trim().min(1).optional(),
      state: z.string().trim().min(1).optional(),
      populations: z.array(z.string().trim().min(1)).optional(),
      needTypes: z.array(z.string().trim().min(1)).optional(),
    })
    .optional(),
});

const POPULATION_KEYWORDS = [
  "youth",
  "teen",
  "teens",
  "teen boys",
  "teen girls",
  "family",
  "families",
  "women",
  "men",
  "lgbtq",
  "veteran",
  "veterans",
  "seniors",
  "children",
  "kids",
];

const NEED_TYPE_KEYWORDS = [
  "shelter",
  "housing",
  "voucher",
  "rapid rehousing",
  "bed",
  "food",
  "meal",
  "clothing",
  "rent",
  "utility",
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "for",
  "help",
  "how",
  "i",
  "in",
  "is",
  "need",
  "near",
  "of",
  "on",
  "please",
  "show",
  "the",
  "to",
  "where",
  "with",
]);

const CITY_HINT_PATTERNS = [
  /in ([^,]+?),/i,
  /in ([^,]+)$/i,
  /near ([^,]+?),/i,
  /near ([^,]+)$/i,
  /around ([^,]+?)$/i,
  /for ([^,]+?),/i,
];

const FALLBACK_MAX_RESULTS = 60;
const MIN_STRONG_MATCHES = 5;

type QueryFilters = z.infer<typeof requestSchema>["filters"];

type QueryHints = {
  query: string;
  normalized: string;
  keywords: string[];
  locationCity: string | null;
  locationCounty: string | null;
  state: string | null;
  populations: string[];
  needTypes: string[];
};

type InterpretedFilters = {
  query: string;
  locationCity: string | null;
  locationCounty: string | null;
  state: string | null;
  populations: string[];
  needTypes: string[];
};

type RawSearchRow = {
  id: string;
  program_name: string | null;
  source_type: "pdf" | "web";
  source_url: string | null;
  page_title: string | null;
  created_at: string | Date | null;
  raw_eligibility_text: string;
  eligibility_json: Eligibility;
  location_city: string | null;
  location_county: string | null;
  location_state: string | null;
  search_text: string;
  rank?: number | null;
  similarity?: number | null;
};

type PipelineStage = "localized" | "relaxed" | "fuzzy" | "fallback";

type PipelineResult = {
  row: RawSearchRow;
  stage: PipelineStage;
};

type SearchServiceSummary = {
  id: string;
  programName: string | null;
  sourceType: "pdf" | "web";
  sourceUrl: string | null;
  pageTitle: string | null;
  createdAt: string | null;
  previewEligibilityText: string;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  populations: string[];
  needTypes: string[];
};

type SearchResponseItem = {
  service: SearchServiceSummary;
  matchReason: string[];
  matchTier: "direct" | "broader" | "fuzzy";
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request." },
        { status: 400 },
      );
    }

    const { query } = parsed.data;
    const limit = parsed.data.limit ?? 20;
    const filters = parsed.data.filters;

    const hints = interpretQuery(query, filters);

    const { results, stages } = await runSearchPipeline({
      hints,
      limit,
    });

    const responseItems = results.slice(0, limit).map(({ row, stage }) =>
      mapToResponseItem(row, stage, hints),
    );

    console.log("eligibility_search", {
      query: hints.query,
      interpretedFilters: {
        city: hints.locationCity,
        county: hints.locationCounty,
        state: hints.state,
        populations: hints.populations,
        needTypes: hints.needTypes,
      },
      resultCount: responseItems.length,
      stages,
    });

    const interpretedFilters: InterpretedFilters = {
      query: hints.query,
      locationCity: hints.locationCity,
      locationCounty: hints.locationCounty,
      state: hints.state,
      populations: hints.populations,
      needTypes: hints.needTypes,
    };

    return NextResponse.json({
      query: hints.query,
      interpretedFilters,
      results: responseItems,
    });
  } catch (error) {
    console.error("search-eligibility failure", error);
    return NextResponse.json(
      {
        error: "search_failed",
        message: "We couldn't run this search right now.",
      },
      { status: 500 },
    );
  }
}

function interpretQuery(query: string, filters?: QueryFilters): QueryHints {
  const normalizedQuery = query.trim();
  const lowercase = normalizedQuery.toLowerCase();

  const cityFromQuery = extractCity(lowercase);
  const countyFromQuery = extractCounty(lowercase);
  const stateFromQuery = extractState(lowercase);

  const populations = collectKeywords(lowercase, POPULATION_KEYWORDS);
  const needTypes = collectKeywords(lowercase, NEED_TYPE_KEYWORDS);
  const keywords = extractKeywords(lowercase);

  const explicitPopulations = filters?.populations ?? [];
  const explicitNeedTypes = filters?.needTypes ?? [];

  const explicitCity = filters?.locationCity?.trim() ?? null;
  const explicitCounty = filters?.locationCounty?.trim() ?? null;
  const explicitState = filters?.state?.trim() ?? null;

  return {
    query: normalizedQuery,
    normalized: lowercase,
    keywords,
    locationCity: explicitCity || cityFromQuery,
    locationCounty: explicitCounty || countyFromQuery,
    state: explicitState || stateFromQuery,
    populations: dedupe([...populations, ...explicitPopulations]),
    needTypes: dedupe([...needTypes, ...explicitNeedTypes]),
  };
}

async function runSearchPipeline({
  hints,
  limit,
}: {
  hints: QueryHints;
  limit: number;
}): Promise<{ results: PipelineResult[]; stages: PipelineStage[] }> {
  const stagesUsed: PipelineStage[] = [];
  const results = new Map<string, PipelineResult>();
  const oversample = Math.min(limit * 3, FALLBACK_MAX_RESULTS);

  if (hints.locationCity || hints.locationCounty) {
    const stageResults = await fullTextSearch({
      hints,
      limit: oversample,
      applyCityCounty: true,
      applyState: Boolean(hints.state),
    });
    addResults(results, stageResults, "localized");
    if (stageResults.length > 0) {
      stagesUsed.push("localized");
    }
  }

  if (results.size < MIN_STRONG_MATCHES) {
    const stageResults = await fullTextSearch({
      hints,
      limit: oversample,
      applyCityCounty: false,
      applyState: Boolean(hints.state),
    });
    addResults(results, stageResults, "relaxed");
    if (stageResults.length > 0) {
      stagesUsed.push("relaxed");
    }
  }

  if (results.size < limit) {
    const stageResults = await fuzzySearch({
      hints,
      limit: oversample,
      applyState: Boolean(hints.state),
    });
    addResults(results, stageResults, "fuzzy");
    if (stageResults.length > 0) {
      stagesUsed.push("fuzzy");
    }
  }

  if (results.size < limit) {
    const stageResults = await fallbackSearch({
      hints,
      limit: oversample,
    });
    addResults(results, stageResults, "fallback");
    if (stageResults.length > 0) {
      stagesUsed.push("fallback");
    }
  }

  const ranked = Array.from(results.values())
    .map((entry) => ({
      ...entry,
      score: scoreResult(entry.row, entry.stage, hints),
    }))
    .sort((a, b) => b.score - a.score);

  return { results: ranked, stages: stagesUsed };
}

async function fullTextSearch({
  hints,
  limit,
  applyCityCounty,
  applyState,
}: {
  hints: QueryHints;
  limit: number;
  applyCityCounty: boolean;
  applyState: boolean;
}) {
  const tsQuery = sql`plainto_tsquery('english', ${hints.query})`;
  const conditions = [sql`${eligibilityDocuments.searchTsv} @@ ${tsQuery}`];

  if (applyCityCounty && hints.locationCity) {
    conditions.push(
      sql`${eligibilityDocuments.locationCity} ILIKE ${`${hints.locationCity}%`}`,
    );
  }

  if (applyCityCounty && hints.locationCounty) {
    conditions.push(
      sql`${eligibilityDocuments.locationCounty} ILIKE ${`${hints.locationCounty}%`}`,
    );
  }

  if (applyState && hints.state) {
    conditions.push(
      sql`${eligibilityDocuments.locationState} ILIKE ${`${hints.state}%`}`,
    );
  }

  const whereClause = sql.join(conditions, sql` AND `);

  const query = sql`
    SELECT
      ${eligibilityDocuments.id} as id,
      ${eligibilityDocuments.programName} as program_name,
      ${eligibilityDocuments.sourceType} as source_type,
      ${eligibilityDocuments.sourceUrl} as source_url,
      ${eligibilityDocuments.pageTitle} as page_title,
      ${eligibilityDocuments.createdAt} as created_at,
      ${eligibilityDocuments.rawEligibilityText} as raw_eligibility_text,
      ${eligibilityDocuments.eligibilityJson} as eligibility_json,
      ${eligibilityDocuments.locationCity} as location_city,
      ${eligibilityDocuments.locationCounty} as location_county,
      ${eligibilityDocuments.locationState} as location_state,
      ${eligibilityDocuments.searchText} as search_text,
      ts_rank_cd(${eligibilityDocuments.searchTsv}, ${tsQuery}) as rank
    FROM ${eligibilityDocuments}
    WHERE ${whereClause}
    ORDER BY rank DESC, ${eligibilityDocuments.createdAt} DESC
    LIMIT ${limit}
  `;

  const result = await db.execute<RawSearchRow>(query);
  return result.rows;
}

async function fuzzySearch({
  hints,
  limit,
  applyState,
}: {
  hints: QueryHints;
  limit: number;
  applyState: boolean;
}) {
  const likeTerm = `%${hints.query}%`;
  const conditions = [
    sql`(${eligibilityDocuments.searchText} ILIKE ${likeTerm} OR similarity(${eligibilityDocuments.searchText}, ${hints.query}) > 0.2)`,
  ];

  if (applyState && hints.state) {
    conditions.push(
      sql`${eligibilityDocuments.locationState} ILIKE ${`${hints.state}%`}`,
    );
  }

  const whereClause = sql.join(conditions, sql` AND `);

  const query = sql`
    SELECT
      ${eligibilityDocuments.id} as id,
      ${eligibilityDocuments.programName} as program_name,
      ${eligibilityDocuments.sourceType} as source_type,
      ${eligibilityDocuments.sourceUrl} as source_url,
      ${eligibilityDocuments.pageTitle} as page_title,
      ${eligibilityDocuments.createdAt} as created_at,
      ${eligibilityDocuments.rawEligibilityText} as raw_eligibility_text,
      ${eligibilityDocuments.eligibilityJson} as eligibility_json,
      ${eligibilityDocuments.locationCity} as location_city,
      ${eligibilityDocuments.locationCounty} as location_county,
      ${eligibilityDocuments.locationState} as location_state,
      ${eligibilityDocuments.searchText} as search_text,
      similarity(${eligibilityDocuments.searchText}, ${hints.query}) as similarity
    FROM ${eligibilityDocuments}
    WHERE ${whereClause}
    ORDER BY similarity DESC, ${eligibilityDocuments.createdAt} DESC
    LIMIT ${limit}
  `;

  const result = await db.execute<RawSearchRow>(query);
  return result.rows;
}

async function fallbackSearch({
  hints,
  limit,
}: {
  hints: QueryHints;
  limit: number;
}) {
  const conditions: any[] = [];
  if (hints.state) {
    conditions.push(
      sql`${eligibilityDocuments.locationState} ILIKE ${`${hints.state}%`}`,
    );
  }

  const whereClause =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const query = sql`
    SELECT
      ${eligibilityDocuments.id} as id,
      ${eligibilityDocuments.programName} as program_name,
      ${eligibilityDocuments.sourceType} as source_type,
      ${eligibilityDocuments.sourceUrl} as source_url,
      ${eligibilityDocuments.pageTitle} as page_title,
      ${eligibilityDocuments.createdAt} as created_at,
      ${eligibilityDocuments.rawEligibilityText} as raw_eligibility_text,
      ${eligibilityDocuments.eligibilityJson} as eligibility_json,
      ${eligibilityDocuments.locationCity} as location_city,
      ${eligibilityDocuments.locationCounty} as location_county,
      ${eligibilityDocuments.locationState} as location_state,
      ${eligibilityDocuments.searchText} as search_text
    FROM ${eligibilityDocuments}
    ${whereClause}
    ORDER BY ${eligibilityDocuments.createdAt} DESC
    LIMIT ${limit}
  `;

  const result = await db.execute<RawSearchRow>(query);
  return result.rows;
}

function addResults(
  accumulator: Map<string, PipelineResult>,
  rows: RawSearchRow[],
  stage: PipelineStage,
) {
  for (const row of rows) {
    if (!accumulator.has(row.id)) {
      accumulator.set(row.id, { row, stage });
    }
  }
}

function mapToResponseItem(
  row: RawSearchRow,
  stage: PipelineStage,
  hints: QueryHints,
): SearchResponseItem {
  const eligibility = row.eligibility_json;
  const createdAt = row.created_at
    ? new Date(row.created_at).toISOString()
    : null;

  const service: SearchServiceSummary = {
    id: row.id,
    programName: row.program_name,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    pageTitle: row.page_title,
    createdAt,
    previewEligibilityText: createSnippet(row.raw_eligibility_text, 220),
    locationCity: row.location_city,
    locationCounty: row.location_county,
    locationState: row.location_state,
    populations: eligibility.population ?? [],
    needTypes: eligibility.requirements ?? [],
  };

  return {
    service,
    matchReason: buildMatchReasons(row, stage, hints),
    matchTier: stageToTier(stage),
  };
}

function scoreResult(
  row: RawSearchRow,
  stage: PipelineStage,
  hints: QueryHints,
) {
  let score = 0;

  if (typeof row.rank === "number") {
    score += row.rank * 2;
  }

  if (typeof row.similarity === "number") {
    score += row.similarity;
  }

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : null;
  if (createdAt) {
    const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 6 - ageDays / 30);
  }

  if (hints.locationCity && row.location_city) {
    if (row.location_city.toLowerCase() === hints.locationCity.toLowerCase()) {
      score += 1.5;
    }
  }

  if (hints.locationCounty && row.location_county) {
    if (row.location_county.toLowerCase().startsWith(hints.locationCounty.toLowerCase())) {
      score += 1;
    }
  }

  if (hints.state && row.location_state) {
    if (row.location_state.toLowerCase().startsWith(hints.state.toLowerCase())) {
      score += 0.75;
    }
  }

  const eligibility = row.eligibility_json;
  const populations = Array.isArray(eligibility.population)
    ? eligibility.population.map((value) => value.toLowerCase())
    : [];
  const needTypes = Array.isArray(eligibility.requirements)
    ? eligibility.requirements.map((value) => value.toLowerCase())
    : [];

  for (const population of hints.populations) {
    if (populations.includes(population.toLowerCase())) {
      score += 1.2;
    }
  }

  for (const needType of hints.needTypes) {
    if (row.search_text.toLowerCase().includes(needType.toLowerCase())) {
      score += 0.8;
    } else if (needTypes.includes(needType.toLowerCase())) {
      score += 0.6;
    }
  }

  if (stage === "localized") {
    score += 1.5;
  } else if (stage === "relaxed") {
    score += 0.5;
  }

  return score;
}

function buildMatchReasons(
  row: RawSearchRow,
  stage: PipelineStage,
  hints: QueryHints,
) {
  const reasons: string[] = [];
  const searchText = row.search_text.toLowerCase();

  const matchedWords = hints.keywords
    .filter((keyword) => searchText.includes(keyword))
    .slice(0, 5);

  if (matchedWords.length > 0) {
    reasons.push(`Matched words: ${matchedWords.join(", ")}`);
  }

  if (hints.locationCity && row.location_city) {
    if (row.location_city.toLowerCase() === hints.locationCity.toLowerCase()) {
      reasons.push(`Located in ${row.location_city}`);
    }
  }

  if (!reasons.length && row.location_city) {
    const locationParts = [row.location_city, row.location_state]
      .filter((value) => value)
      .join(", ");
    if (locationParts) {
      reasons.push(`Nearby: ${locationParts}`);
    }
  }

  const eligibility = row.eligibility_json;
  const populations = Array.isArray(eligibility.population)
    ? eligibility.population
    : [];

  const matchingPopulations = populations.filter((population) =>
    hints.populations.some((hint) => population.toLowerCase().includes(hint)),
  );

  if (matchingPopulations.length > 0) {
    reasons.push(`Serves: ${matchingPopulations.join(", ")}`);
  }

  const matchingNeeds = hints.needTypes.filter((need) =>
    searchText.includes(need.toLowerCase()),
  );

  if (matchingNeeds.length > 0) {
    reasons.push(`Matches need: ${matchingNeeds.join(", ")}`);
  }

  if (stage === "fuzzy") {
    reasons.push("Fuzzy match on similar wording");
  } else if (stage === "fallback") {
    reasons.push("Showing broader options in the region");
  }

  if (reasons.length === 0) {
    reasons.push("Recently added to your library");
  }

  return reasons;
}

function stageToTier(stage: PipelineStage): "direct" | "broader" | "fuzzy" {
  switch (stage) {
    case "localized":
      return "direct";
    case "relaxed":
      return "broader";
    case "fuzzy":
      return "fuzzy";
    case "fallback":
      return "broader";
    default:
      return "broader";
  }
}

function extractKeywords(query: string) {
  return Array.from(
    new Set(
      query
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length > 2 &&
            !STOP_WORDS.has(token) &&
            !POPULATION_KEYWORDS.includes(token) &&
            !NEED_TYPE_KEYWORDS.includes(token),
        ),
    ),
  );
}

function collectKeywords(query: string, options: string[]) {
  const matches = new Set<string>();
  for (const keyword of options) {
    if (query.includes(keyword)) {
      matches.add(keyword.toLowerCase());
    }
  }
  return Array.from(matches);
}

function extractCity(query: string): string | null {
  for (const pattern of CITY_HINT_PATTERNS) {
    const match = query.match(pattern);
    if (match && match[1]) {
      return titleCase(match[1]);
    }
  }
  return null;
}

function extractCounty(query: string): string | null {
  const countyMatch = query.match(/([a-z\s]+?\s+(county|parish|borough))/);
  if (countyMatch) {
    return titleCase(countyMatch[1]);
  }
  return null;
}

const STATE_NAMES = new Map<string, string>([
  ["alabama", "AL"],
  ["alaska", "AK"],
  ["arizona", "AZ"],
  ["arkansas", "AR"],
  ["california", "CA"],
  ["colorado", "CO"],
  ["connecticut", "CT"],
  ["delaware", "DE"],
  ["district of columbia", "DC"],
  ["florida", "FL"],
  ["georgia", "GA"],
  ["hawaii", "HI"],
  ["idaho", "ID"],
  ["illinois", "IL"],
  ["indiana", "IN"],
  ["iowa", "IA"],
  ["kansas", "KS"],
  ["kentucky", "KY"],
  ["louisiana", "LA"],
  ["maine", "ME"],
  ["maryland", "MD"],
  ["massachusetts", "MA"],
  ["michigan", "MI"],
  ["minnesota", "MN"],
  ["mississippi", "MS"],
  ["missouri", "MO"],
  ["montana", "MT"],
  ["nebraska", "NE"],
  ["nevada", "NV"],
  ["new hampshire", "NH"],
  ["new jersey", "NJ"],
  ["new mexico", "NM"],
  ["new york", "NY"],
  ["north carolina", "NC"],
  ["north dakota", "ND"],
  ["ohio", "OH"],
  ["oklahoma", "OK"],
  ["oregon", "OR"],
  ["pennsylvania", "PA"],
  ["rhode island", "RI"],
  ["south carolina", "SC"],
  ["south dakota", "SD"],
  ["tennessee", "TN"],
  ["texas", "TX"],
  ["utah", "UT"],
  ["vermont", "VT"],
  ["virginia", "VA"],
  ["washington", "WA"],
  ["west virginia", "WV"],
  ["wisconsin", "WI"],
  ["wyoming", "WY"],
]);

function extractState(query: string): string | null {
  for (const [name, abbreviation] of STATE_NAMES.entries()) {
    if (query.includes(name)) {
      return abbreviation;
    }
  }

  const abbreviationMatch = query.match(/\b([a-z]{2})\b/);
  if (abbreviationMatch) {
    const candidate = abbreviationMatch[1].toUpperCase();
    if (Array.from(STATE_NAMES.values()).includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createSnippet(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}
