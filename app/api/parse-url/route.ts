import { NextRequest, NextResponse } from "next/server";
import { load } from "cheerio";
import { db } from "@/db";
import { eligibilityDocuments } from "@/db/schema";
import { extractEligibility } from "@/lib/eligibility-extractor";
import {
  buildSearchText,
  deriveLocationFromEligibility,
} from "@/lib/search-text";

const MAX_PAGE_TEXT_LENGTH = 20_000;
const RESPONSE_SNIPPET_LENGTH = 2_000;

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json(
        { error: "A URL is required in the request body." },
        { status: 400 },
      );
    }

    let normalizedUrl: URL;

    try {
      normalizedUrl = new URL(body.url);
    } catch {
      return NextResponse.json(
        { error: "The provided URL is not valid." },
        { status: 400 },
      );
    }

    const response = await fetch(normalizedUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "EligibilityIngestorBot/1.0 (+https://pdf-parser-git-main-macleanlukes-projects.vercel.app/)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: `Failed to fetch page content (status ${response.status}).`,
        },
        { status: 502 },
      );
    }

    const html = await response.text();

    const { text, title } = extractMainContent(html);

    if (!text) {
      return NextResponse.json(
        {
          error:
            "Could not extract readable text from the provided URL. Please try another page.",
        },
        { status: 502 },
      );
    }

    const eligibility = await extractEligibility({
      text,
      sourceType: "web",
      metadata: {
        title,
        url: normalizedUrl.href,
      },
      maxCharacters: MAX_PAGE_TEXT_LENGTH,
    });

    if (!eligibility.rawEligibilityText.trim()) {
      return NextResponse.json(
        {
          error:
            "We read the page but couldn’t find clear information about who the service helps or what’s required. Please double-check the page or choose another source.",
        },
        { status: 422 },
      );
    }

    const rawTextSnippet = createSnippet(text, RESPONSE_SNIPPET_LENGTH);
    const location = deriveLocationFromEligibility(eligibility);
    const searchText = buildSearchText({
      programName: eligibility.programName,
      pageTitle: title ?? null,
      eligibility,
      rawEligibilityText: eligibility.rawEligibilityText,
      location,
    });

    const [record] = await db
      .insert(eligibilityDocuments)
      .values({
        fileName: title ?? "web-page",
        fileSize: text.length,
        mimeType: "text/html",
        rawText: text,
        rawEligibilityText: eligibility.rawEligibilityText,
        eligibilityJson: eligibility,
        programName: eligibility.programName,
        sourceType: "web",
        sourceUrl: normalizedUrl.href,
        pageTitle: title,
        locationCity: location.city,
        locationCounty: location.county,
        locationState: location.state,
        searchText,
      })
      .returning();

    const createdAt =
      typeof record.createdAt === "string"
        ? record.createdAt
        : record.createdAt?.toISOString() ?? null;

    const sourceType = "web" as const;

    const detail = {
      id: record.id,
      sourceType,
      sourceUrl: record.sourceUrl,
      pageTitle: record.pageTitle,
      programName: record.programName,
      rawEligibilityText: record.rawEligibilityText,
      eligibility,
      createdAt,
      rawTextSnippet,
      locationCity: record.locationCity,
      locationCounty: record.locationCounty,
      locationState: record.locationState,
    };

    const service = createServiceSummary({
      ...detail,
      populations: eligibility.population,
      needTypes: eligibility.requirements,
    });

    return NextResponse.json({
      ...detail,
      record: detail,
      service,
    });
  } catch (error) {
    console.error("Failed to parse eligibility from URL", error);
    return NextResponse.json(
      { error: "Failed to analyze the provided URL. Please try again." },
      { status: 500 },
    );
  }
}

function extractMainContent(html: string) {
  const $ = load(html);

  const title = $("title").first().text().trim() || null;

  $("script, style, noscript, iframe, svg, nav, header, footer, aside").remove();

  const candidates = ["main", "article", "[role='main']", ".content", ".post"];
  let content = "";

  for (const selector of candidates) {
    const element = $(selector);
    if (element.length) {
      content = element
        .text()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");

      if (content.length > 500) {
        break;
      }
    }
  }

  if (!content || content.length < 300) {
    content = $("body")
      .text()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }

  return {
    title,
    text: sanitizeText(content, MAX_PAGE_TEXT_LENGTH),
  };
}

function sanitizeText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n...[truncated]`;
}

function createSnippet(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}

function createServiceSummary(record: {
  id: string;
  programName: string | null;
  sourceType: "pdf" | "web";
  sourceUrl: string | null;
  pageTitle: string | null;
  createdAt: string | null;
  rawEligibilityText: string;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  populations: string[];
  needTypes: string[];
}) {
  return {
    id: record.id,
    programName: record.programName,
    sourceType: record.sourceType,
    sourceUrl: record.sourceUrl,
    pageTitle: record.pageTitle,
    createdAt: record.createdAt,
    previewEligibilityText: createSnippet(record.rawEligibilityText, 220),
    locationCity: record.locationCity,
    locationCounty: record.locationCounty,
    locationState: record.locationState,
    populations: record.populations,
    needTypes: record.needTypes,
  };
}
