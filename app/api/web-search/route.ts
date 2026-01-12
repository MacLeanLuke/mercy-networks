import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

type WebResult = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
};

const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_KEY;

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const clientIp = getClientIp(request);
    const rateLimitResult = checkRateLimit(
      `web-search:${clientIp}`,
      RATE_LIMITS.WEB_SEARCH.maxRequests,
      RATE_LIMITS.WEB_SEARCH.windowMs,
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
        { error: "A search query is required." },
        { status: 400 },
      );
    }

    if (!GOOGLE_CSE_ID || !GOOGLE_CSE_KEY) {
      console.error("Web search attempted without GOOGLE_CSE_ID/KEY");
      return NextResponse.json(
        { error: "Web search is currently unavailable." },
        { status: 503 },
      );
    }

    const params = new URLSearchParams({
      key: GOOGLE_CSE_KEY,
      cx: GOOGLE_CSE_ID,
      q: query,
      num: "8",
    });

    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      console.error("Web search provider error", response.status, text);
      return NextResponse.json(
        { error: "Unable to reach the web search provider." },
        { status: 502 },
      );
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.items) ? payload.items : [];

    const results: WebResult[] = items
      .map((item: any, index: number) => {
        const url: string | undefined =
          item?.link ?? item?.formattedUrl ?? undefined;
        if (!url) {
          return null;
        }

        const idSource = item?.cacheId ?? `${url}-${index}`;
        const id = createHash("sha1").update(idSource).digest("hex");

        let displayUrl = url;
        try {
          displayUrl = new URL(url).hostname;
        } catch {
          // noop, fallback to raw url
        }

        return {
          id,
          title: (item?.title as string) ?? item?.htmlTitle ?? url,
          url,
          snippet:
            (item?.snippet as string) ??
            sanitizeSnippet(item?.htmlSnippet) ??
            "",
          displayUrl:
            (item?.displayLink as string) ??
            (item?.formattedUrl as string) ??
            displayUrl,
        };
      })
      .filter(Boolean)
      .slice(0, 8) as WebResult[];

    return NextResponse.json({ query, results });
  } catch (error) {
    console.error("web-search failure", error);
    return NextResponse.json(
      { error: "Web search failed. Please try again." },
      { status: 500 },
    );
  }
}

function sanitizeSnippet(value?: string) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
