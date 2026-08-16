import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { eligibilityDocuments } from "@/db/schema";

const DETAIL_SNIPPET_LENGTH = 2_000;

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const { id } = params;

    if (!id) {
      return NextResponse.json(
        { error: "Record ID is required." },
        { status: 400 },
      );
    }

    const record = await db.query.eligibilityDocuments.findFirst({
      where: eq(eligibilityDocuments.id, id),
    });

    if (!record) {
      return NextResponse.json({ error: "Record not found." }, { status: 404 });
    }

    return NextResponse.json({
      id: record.id,
      programName: record.programName,
      sourceType: record.sourceType,
      sourceUrl: record.sourceUrl,
      pageTitle: record.pageTitle,
      createdAt: record.createdAt,
      rawEligibilityText: record.rawEligibilityText,
      rawTextSnippet: createSnippet(record.rawText, DETAIL_SNIPPET_LENGTH),
      eligibility: record.eligibilityJson,
      locationCity: record.locationCity,
      locationCounty: record.locationCounty,
      locationState: record.locationState,
    });
  } catch (error) {
    console.error("Failed to load eligibility record", error);
    return NextResponse.json(
      { error: "Failed to load eligibility record." },
      { status: 500 },
    );
  }
}

function createSnippet(text: string, maxLength: number) {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}
