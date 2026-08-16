import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { parsePDF } from "@/lib/pdf-parser";
import { extractEligibility } from "@/lib/eligibility-extractor";
import { db } from "@/db";
import { eligibilityDocuments } from "@/db/schema";
import {
  buildSearchText,
  deriveLocationFromEligibility,
} from "@/lib/search-text";

const MAX_RAW_TEXT_LENGTH = 50_000;
const RESPONSE_SNIPPET_LENGTH = 2_000;

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "A single PDF file is required." },
        { status: 400 }
      );
    }

    if (file.type && file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length === 0) {
      return NextResponse.json(
        { error: "Uploaded file is empty." },
        { status: 400 }
      );
    }

    const hash = createHash("sha256").update(buffer).digest("hex");

    const { text, metadata } = await parsePDF(buffer, { cleanText: true });

    const eligibility = await extractEligibility({
      text,
      sourceType: "pdf",
      metadata: {
        fileName: file.name,
        title: metadata?.title ?? null,
      },
    });

    if (!eligibility.rawEligibilityText.trim()) {
      return NextResponse.json(
        {
          error:
            "We couldn’t find clear service details in this PDF. Make sure the file describes who the service helps and what someone needs to do next.",
        },
        { status: 422 },
      );
    }

    const truncatedRawText =
      text.length > MAX_RAW_TEXT_LENGTH
        ? `${text.slice(0, MAX_RAW_TEXT_LENGTH)}\n...[truncated]`
        : text;

    const rawTextSnippet = createSnippet(truncatedRawText, RESPONSE_SNIPPET_LENGTH);

    const location = deriveLocationFromEligibility(eligibility);
    const searchText = buildSearchText({
      programName: eligibility.programName,
      pageTitle: metadata?.title ?? null,
      eligibility,
      rawEligibilityText: eligibility.rawEligibilityText,
      location,
    });

    const [record] = await db
      .insert(eligibilityDocuments)
      .values({
        fileName: file.name,
        fileSize: buffer.length,
        mimeType: file.type || "application/pdf",
        rawText: truncatedRawText,
        rawEligibilityText: eligibility.rawEligibilityText,
        eligibilityJson: eligibility,
        programName: eligibility.programName,
        hash,
        sourceType: "pdf",
        sourceUrl: null,
        pageTitle: metadata?.title ?? null,
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

    const sourceType =
      record.sourceType === "web" ? ("web" as const) : ("pdf" as const);

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
    console.error("Failed to parse eligibility PDF", error);
    return NextResponse.json(
      { error: "Failed to analyze PDF. Please try again." },
      { status: 500 }
    );
  }
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
