import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  searchFilterSchema,
  searchInterpretationPrompt,
  normalizeSearchFilters,
  type SearchFilter,
} from "@/lib/search-filter";
import { db } from "@/db";
import { eligibilityDocuments } from "@/db/schema";
import { and, desc, ilike, or, sql } from "drizzle-orm";
import { createServerAiProvider } from "@/lib/ai-providers";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

const serverAi = createServerAiProvider({ fallbackModel: "gpt-4.1-mini" });

const MODEL_NAME =
  (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()) ||
  serverAi.defaultModel;

type SearchResult = {
  id: string;
  programName: string | null;
  sourceType: "pdf" | "web";
  sourceUrl: string | null;
  pageTitle: string | null;
  createdAt: string | null;
  rawEligibilityText: string;
};

type SearchResponseItem = {
  id: string;
  programName: string | null;
  sourceType: "pdf" | "web";
  sourceUrl: string | null;
  pageTitle: string | null;
  createdAt: string | null;
  previewEligibilityText: string;
};

const partialFilterSchema = searchFilterSchema.partial();

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const clientIp = getClientIp(request);
    const rateLimitResult = checkRateLimit(
      `ai-search:${clientIp}`,
      RATE_LIMITS.AI_SEARCH.maxRequests,
      RATE_LIMITS.AI_SEARCH.windowMs,
    );

    if (!rateLimitResult.success) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded. Please try again later.",
          reset: new Date(rateLimitResult.reset).toISOString(),
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(rateLimitResult.limit),
            "X-RateLimit-Remaining": String(rateLimitResult.remaining),
            "X-RateLimit-Reset": String(rateLimitResult.reset),
          },
        },
      );
    }

    const body = await request.json().catch(() => null);
    const query =
      typeof body?.query === "string" && body.query.trim().length > 0
        ? body.query.trim()
        : null;

    if (!query) {
      return NextResponse.json(
        { error: "Query is required." },
        { status: 400 },
      );
    }

    const limit =
      typeof body?.limit === "number" && body.limit > 0
        ? Math.min(body.limit, 50)
        : 20;

    const filtersOverride = parseFiltersOverride(body?.filtersOverride, query);

    const filters = filtersOverride ?? (await interpretQuery(query));

    const records = await searchDatabase(filters, limit * 3);
    const results = rankResults(records, filters, query).slice(0, limit);

    return NextResponse.json({
      query,
      filters,
      results,
    });
  } catch (error) {
    console.error("search-eligibility failure", error);
    return NextResponse.json(
      { error: "Search failed. Please try again." },
      { status: 500 },
    );
  }
}

async function interpretQuery(query: string): Promise<SearchFilter> {
  try {
    serverAi.ensureConfigured();

    const { object } = await serverAi.generateObject({
      model: serverAi.getModel(MODEL_NAME),
      schema: searchFilterSchema,
      messages: [
        { role: "system", content: searchInterpretationPrompt },
        { role: "user", content: query },
      ],
    });

    return normalizeSearchFilters(object, query);
  } catch (error) {
    console.warn("Falling back to simple search filter", error);
    return {
      textQuery: query,
      populations: [],
      genderRestriction: null,
      locations: [],
      requirementsInclude: [],
    };
  }
}

async function searchDatabase(
  filters: SearchFilter,
  limit: number,
): Promise<SearchResult[]> {
  const conditions = [];

  if (filters.textQuery) {
    const pattern = `%${filters.textQuery}%`;
    conditions.push(
      or(
        ilike(eligibilityDocuments.programName, pattern),
        ilike(eligibilityDocuments.pageTitle, pattern),
        ilike(eligibilityDocuments.sourceUrl, pattern),
        ilike(eligibilityDocuments.rawEligibilityText, pattern),
      ),
    );
  }

  [...filters.populations, ...filters.locations, ...filters.requirementsInclude]
    .map((value) => value.toLowerCase())
    .forEach((value) => {
      conditions.push(
        sql<boolean>`${eligibilityDocuments.eligibilityJson}::text ILIKE ${`%${value}%`}`,
      );
    });

  if (filters.genderRestriction && filters.genderRestriction !== "any") {
    conditions.push(
      sql<boolean>`${eligibilityDocuments.eligibilityJson}->>'genderRestriction' ILIKE ${filters.genderRestriction}`,
    );
  }

  const baseQuery = db
    .select({
      id: eligibilityDocuments.id,
      programName: eligibilityDocuments.programName,
      sourceType: eligibilityDocuments.sourceType,
      sourceUrl: eligibilityDocuments.sourceUrl,
      pageTitle: eligibilityDocuments.pageTitle,
      createdAt: eligibilityDocuments.createdAt,
      rawEligibilityText: eligibilityDocuments.rawEligibilityText,
    })
    .from(eligibilityDocuments);

  const whereClause =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

  const queryBuilder = whereClause
    ? baseQuery.where(whereClause)
    : baseQuery;

  const rawRecords = await queryBuilder
    .orderBy(desc(eligibilityDocuments.createdAt))
    .limit(limit);

  return rawRecords.map((record) => ({
    ...record,
    sourceType: (record.sourceType as "pdf" | "web") ?? "pdf",
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : null,
  }));
}

function rankResults(
  records: SearchResult[],
  filters: SearchFilter,
  query: string,
) {
  const lowerQuery = query.toLowerCase();

  const scored = records.map((record) => {
    let score = 0;
    const name = record.programName?.toLowerCase() ?? "";
    const pageTitle = record.pageTitle?.toLowerCase() ?? "";
    const text = record.rawEligibilityText.toLowerCase();

    if (name.includes(lowerQuery)) score += 6;
    if (pageTitle.includes(lowerQuery)) score += 4;
    if (text.includes(lowerQuery)) score += 3;

    if (filters.textQuery) {
      const filterText = filters.textQuery.toLowerCase();
      if (name.includes(filterText)) score += 4;
      if (pageTitle.includes(filterText)) score += 3;
      if (text.includes(filterText)) score += 2;
    }

    filters.populations.forEach((population) => {
      if (text.includes(population.toLowerCase())) score += 2;
    });

    filters.locations.forEach((location) => {
      if (text.includes(location.toLowerCase())) score += 1.5;
    });

    if (filters.genderRestriction && filters.genderRestriction !== "any") {
      if (text.includes(filters.genderRestriction.toLowerCase())) {
        score += 1;
      }
    }

    const recencyBonus = record.createdAt
      ? Date.now() - new Date(record.createdAt).getTime()
      : Number.MAX_SAFE_INTEGER;
    const recencyScore = Math.max(
      0,
      4 - Math.log10(Math.max(recencyBonus, 1)) / 5,
    );
    score += recencyScore;

    return {
      ...record,
      score,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeB - timeA;
  });

  return scored.map<SearchResponseItem>((record) => ({
    id: record.id,
    programName: record.programName,
    sourceType: record.sourceType,
    sourceUrl: record.sourceUrl,
    pageTitle: record.pageTitle,
    createdAt: record.createdAt,
    previewEligibilityText: createSnippet(record.rawEligibilityText, 220),
  }));
}

function parseFiltersOverride(
  value: unknown,
  fallbackQuery: string,
): SearchFilter | null {
  const parsed = partialFilterSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return normalizeSearchFilters(parsed.data, fallbackQuery);
}

function createSnippet(text: string, length: number) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= length) {
    return cleaned;
  }
  return `${cleaned.slice(0, length)}…`;
}
