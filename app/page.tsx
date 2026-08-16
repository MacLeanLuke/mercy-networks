"use client";

import { useCallback, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import {
  ArrowRight,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Lock,
  Search,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { track } from "@vercel/analytics/react";
import SearchBar from "@/components/search-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import EligibilityResult from "@/components/eligibility-result";
import type { Eligibility } from "@/lib/eligibility-schema";
import { useBuiltInAiInterpreter } from "@/app/hooks/useBuiltInAiInterpreter";
import { tryExtractEligibilityInBrowser } from "@/lib/eligibility-extractor.browser";

type ServiceSummary = {
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

type SearchResultItem = {
  service: ServiceSummary;
  matchReason: string[];
  matchTier: "direct" | "broader" | "fuzzy";
};

type InterpretedFilters = {
  query: string;
  locationCity: string | null;
  locationCounty: string | null;
  state: string | null;
  populations: string[];
  needTypes: string[];
};

type SearchResponse = {
  query: string;
  interpretedFilters: InterpretedFilters;
  results: SearchResultItem[];
};

type EligibilityRecordDetail = {
  id: string;
  programName: string | null;
  sourceType: "pdf" | "web";
  sourceUrl: string | null;
  pageTitle: string | null;
  rawEligibilityText: string;
  rawTextSnippet: string;
  eligibility: Eligibility;
  createdAt: string;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
};

type WebResult = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
};

type SearchStatus = "idle" | "loading" | "success" | "error";

type IngestPayload = {
  record: EligibilityRecordDetail;
  result: SearchResultItem;
};

const BROWSER_EXTRACTION_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_BROWSER_EXTRACTION === "true";
const MAX_BROWSER_HTML_LENGTH = 20_000;

export default function Home() {
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searchFilters, setSearchFilters] =
    useState<InterpretedFilters | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] =
    useState<EligibilityRecordDetail | null>(null);
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null);
  const [highlightedServiceId, setHighlightedServiceId] = useState<string | null>(
    null,
  );
  const [localIngestPlaceholder, setLocalIngestPlaceholder] = useState<
    { id: string; url: string } | null
  >(null);

  const [webSearchQuery, setWebSearchQuery] = useState("");
  const [webResults, setWebResults] = useState<WebResult[]>([]);
  const [webSearchStatus, setWebSearchStatus] =
    useState<SearchStatus>("idle");
  const [webSearchError, setWebSearchError] = useState<string | null>(null);
  const [selectedWebResult, setSelectedWebResult] =
    useState<WebResult | null>(null);

  const [scanStatus, setScanStatus] = useState<SearchStatus>("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanRecord, setScanRecord] = useState<EligibilityRecordDetail | null>(
    null,
  );

  const [manualWebsiteUrl, setManualWebsiteUrl] = useState("");
  const [manualWebsiteError, setManualWebsiteError] = useState<string | null>(
    null,
  );
  const [manualWebsiteLoading, setManualWebsiteLoading] = useState(false);

  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const [filterDraft, setFilterDraft] = useState<InterpretedFilters | null>(null);
  const builtInInterpreter = useBuiltInAiInterpreter();

  const hasSearched = searchStatus !== "idle";
  const noServices = searchStatus === "success" && results.length === 0;

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (searchStatus === "error") {
      setSearchStatus("idle");
    }
    setSearchError(null);
  };

  const executeSearch = async (
    input: string,
    filtersOverride?: InterpretedFilters,
  ) => {
    const trimmed = input.trim();
    if (!trimmed) {
      setSearchError("Please enter a search query.");
      setSearchStatus("error");
      return;
    }

    setQuery(trimmed);
    setSearchStatus("loading");
    setSearchError(null);
    setHighlightedServiceId(null);

    try {
      const response = await fetch("/api/search-eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          limit: 20,
          filters: filtersOverride
            ? formatFiltersForRequest(filtersOverride)
            : undefined,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Search failed.");
      }

      const payload = (await response.json()) as SearchResponse;
      setResults(payload.results);
      setSearchFilters(payload.interpretedFilters);
      setSearchStatus("success");
      setSelectedRecord(null);
      setWebResults([]);
      setSelectedWebResult(null);
      setScanRecord(null);
      setScanError(null);
      setWebSearchError(null);
      setWebSearchStatus("idle");
      setWebSearchQuery(`${payload.query} homeless services`);

      if (payload.results.length === 0) {
        void executeWebSearch(`${payload.query} homeless services`, true);
      }
    } catch (error) {
      console.error("Search failed", error);
      setSearchStatus("error");
      setSearchError(
        error instanceof Error ? error.message : "Search failed. Try again.",
      );
    }
  };

  const handleSearch = (value: string) => {
    void executeSearch(value);
  };

  const viewRecordDetails = async (id: string) => {
    setLoadingRecordId(id);
    try {
      const response = await fetch(`/api/eligibility-records/${id}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Failed to load record.");
      }
      const payload = (await response.json()) as EligibilityRecordDetail & {
        createdAt?: string | null;
      };
      setSelectedRecord({
        ...payload,
        createdAt: payload.createdAt ?? new Date().toISOString(),
      });
      setScanRecord(null);
    } catch (error) {
      console.error("Failed to load record", error);
      setSearchError(
        error instanceof Error ? error.message : "Unable to load record.",
      );
    } finally {
      setLoadingRecordId(null);
    }
  };

  const executeWebSearch = async (
    overrideQuery?: string,
    suppressErrorMessage = false,
  ) => {
    const term = (overrideQuery ?? webSearchQuery ?? query).trim();
    if (!term) {
      if (!suppressErrorMessage) {
        setWebSearchError("Enter words to explore the web.");
      }
      return;
    }

    setWebSearchQuery(term);
    setWebSearchStatus("loading");
    setWebSearchError(null);
    setSelectedWebResult(null);
    setScanRecord(null);
    setScanError(null);

    try {
      const response = await fetch("/api/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: term }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Web search failed.");
      }

      const payload = (await response.json()) as { results: WebResult[] };
      setWebResults(payload.results);
      setWebSearchStatus("success");
    } catch (error) {
      console.error("Web search failed", error);
      setWebSearchStatus("error");
      const message =
        error instanceof Error
          ? error.message
          : "Unable to contact the web search service.";
      if (!suppressErrorMessage) {
        setWebSearchError(message);
      }
    }
  };

  const attemptBrowserEligibilityFromUrl = useCallback(
    async (url: string, options?: { preview?: boolean }) => {
      if (!BROWSER_EXTRACTION_ENABLED) {
        return null;
      }

      try {
        // Ensure the URL is valid before making any requests.
        const normalizedUrl = new URL(url).toString();
        const response = await fetch(normalizedUrl, {
          method: "GET",
          credentials: "omit",
        });

        if (!response.ok) {
          track("chrome_ai_browser_extraction", {
            status: "http_error",
            reason: String(response.status),
          });
          return null;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text")) {
          track("chrome_ai_browser_extraction", {
            status: "skipped",
            reason: "unsupported_content_type",
          });
          return null;
        }

        const rawHtml = await response.text();
        const pageTitle = extractTitleFromHtml(rawHtml);
        const text = extractVisibleTextFromHtml(rawHtml).slice(
          0,
          MAX_BROWSER_HTML_LENGTH,
        );

        if (!text) {
          track("chrome_ai_browser_extraction", {
            status: "skipped",
            reason: "empty_text",
          });
          return null;
        }

        const eligibility = await tryExtractEligibilityInBrowser({
          text,
          sourceType: "web",
          metadata: {
            url: normalizedUrl,
            title: pageTitle,
          },
          requestAccess: true,
        });

        if (!eligibility) {
          track("chrome_ai_browser_extraction", {
            status: "failed",
            reason: "model_unavailable",
          });
          return null;
        }

        const id =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? `local-${crypto.randomUUID()}`
            : `local-${Date.now().toString(36)}`;

        const record: EligibilityRecordDetail = {
          id,
          programName: eligibility.programName,
          sourceType: "web",
          sourceUrl: normalizedUrl,
          pageTitle: pageTitle ?? null,
          rawEligibilityText: eligibility.rawEligibilityText,
          rawTextSnippet: eligibility.rawEligibilityText,
          eligibility,
          createdAt: new Date().toISOString(),
          locationCity: null,
          locationCounty: null,
          locationState: null,
        };

        const summary: ServiceSummary = {
          id,
          programName: record.programName,
          sourceType: record.sourceType,
          sourceUrl: record.sourceUrl,
          pageTitle: record.pageTitle,
          createdAt: record.createdAt,
          previewEligibilityText: snippet(record.rawEligibilityText, 220),
          locationCity: null,
          locationCounty: null,
          locationState: null,
          populations: eligibility.population ?? [],
          needTypes: eligibility.requirements ?? [],
        };

        if (options?.preview) {
          setScanRecord(record);
          track("chrome_ai_browser_extraction", {
            status: "success",
            mode: "preview",
          });
          return { record, summary };
        }

        setResults((prev) => {
          const filtered = prev.filter(
            (result) => result.service.id !== summary.id,
          );
          const nextResult: SearchResultItem = {
            service: summary,
            matchReason: ["Added from browser"],
            matchTier: "direct",
          };
          return [nextResult, ...filtered];
        });
        setHighlightedServiceId(summary.id);
        setSelectedRecord(record);
        setScanRecord(null);
        setSearchStatus("success");
        setLocalIngestPlaceholder({ id: summary.id, url: normalizedUrl });
        track("chrome_ai_browser_extraction", {
          status: "success",
          mode: "ingest",
        });
        return { record, summary };
      } catch (error) {
        console.warn("Browser eligibility extraction failed", error);
        track("chrome_ai_browser_extraction", {
          status: "error",
          reason: error instanceof Error ? error.name : "unknown",
        });
        return null;
      }
    },
    [
      setHighlightedServiceId,
      setLocalIngestPlaceholder,
      setScanRecord,
      setSearchStatus,
      setSelectedRecord,
      setResults,
    ],
  );

  const handleFiltersChange = (nextFilters: InterpretedFilters) => {
    const baseQuery = nextFilters.query?.trim() || query;
    setQuery(baseQuery);
    setSearchFilters(nextFilters);
    void executeSearch(baseQuery, nextFilters);
  };

  const handleBroadenSearch = () => {
    if (!searchFilters) return;
    const next: InterpretedFilters = {
      ...searchFilters,
      locationCity: null,
      locationCounty: null,
      populations: [],
      needTypes: [],
    };
    handleFiltersChange(next);
  };

  const openFilterEditor = () => {
    if (searchFilters) {
      setFilterDraft(cloneFilters(searchFilters));
    }
  };

  const closeFilterEditor = () => {
    setFilterDraft(null);
  };

  const applyFilterDraft = () => {
    if (!filterDraft) return;
    handleFiltersChange(filterDraft);
    setFilterDraft(null);
  };

  const handleSelectWebResult = (result: WebResult) => {
    setSelectedWebResult(result);
    setScanRecord(null);
    setScanError(null);
    setScanStatus("idle");
  };

  const ingestFromUrl = async (url: string, options?: { preview?: boolean }) => {
    const response = await fetch("/api/parse-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to analyze website.");
    }

    const payload = await response.json();
    const { record, result } = normalizeIngestPayload(payload);
    const webResult: SearchResultItem = {
      ...result,
      matchReason: ["Saved from website"],
    };
    const summary = webResult.service;

    const matchesPlaceholder =
      localIngestPlaceholder &&
      urlsMatch(localIngestPlaceholder.url, summary.sourceUrl ?? url);

    setResults((prev) => {
      const withoutPlaceholder = matchesPlaceholder
        ? prev.filter(
            (item) => item.service.id !== localIngestPlaceholder!.id,
          )
        : prev;
      const filtered = withoutPlaceholder.filter(
        (item) => item.service.id !== summary.id,
      );
      return [webResult, ...filtered];
    });
    if (matchesPlaceholder) {
      setLocalIngestPlaceholder(null);
    }
    setHighlightedServiceId(summary.id);
    setSelectedRecord(record);

    if (options?.preview) {
      setScanRecord(record);
    }

    setSearchStatus("success");

    return record;
  };

  const handleScanSelectedWebsite = async () => {
    if (!selectedWebResult) return;
    setScanStatus("loading");
    setScanError(null);
    let localPreview = false;
    try {
      const preview = await attemptBrowserEligibilityFromUrl(
        selectedWebResult.url,
        { preview: true },
      );
      localPreview = Boolean(preview);
    } catch (error) {
      console.warn("Local preview failed", error);
    }

    try {
      await ingestFromUrl(selectedWebResult.url, { preview: true });
      setScanStatus("success");
    } catch (error) {
      console.error("Website ingest failed", error);
      if (!localPreview) {
        setScanStatus("error");
        setScanError(
          error instanceof Error
            ? error.message
            : "Unable to analyze the selected website.",
        );
      } else {
        setScanStatus("success");
      }
    }
  };

  const handleManualWebsiteIngest = async () => {
    const trimmed = manualWebsiteUrl.trim();
    if (!trimmed) {
      setManualWebsiteError("Please paste a program page URL.");
      return;
    }

    try {
      new URL(trimmed);
    } catch {
      setManualWebsiteError("Enter a valid URL including https://");
      return;
    }

    setManualWebsiteLoading(true);
    setManualWebsiteError(null);
    let localPreview = false;
    try {
      const local = await attemptBrowserEligibilityFromUrl(trimmed);
      localPreview = Boolean(local);
    } catch (error) {
      console.warn("Browser extraction for manual URL failed", error);
    }
    try {
      await ingestFromUrl(trimmed);
      setManualWebsiteUrl("");
    } catch (error) {
      console.error("Manual website ingest failed", error);
      if (!localPreview) {
        setManualWebsiteError(
          error instanceof Error
            ? error.message
            : "Unable to analyze the provided URL.",
        );
      }
    } finally {
      setManualWebsiteLoading(false);
    }
  };

  const handlePdfChange = (file: File | null) => {
    setPdfFile(file);
    setPdfError(null);
  };

  const handlePdfUpload = async () => {
    if (!pdfFile) {
      setPdfError("Please select a PDF to upload.");
      return;
    }

    const formData = new FormData();
    formData.append("file", pdfFile);

    setPdfLoading(true);
    setPdfError(null);
    try {
      const response = await fetch("/api/parse-eligibility", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Failed to analyze PDF.");
      }

      const payload = await response.json();
      const { record, result } = normalizeIngestPayload(payload);
      const pdfResult: SearchResultItem = {
        ...result,
        matchReason: ["Saved from PDF upload"],
      };

      setPdfFile(null);
      setResults((prev) => {
        const filtered = prev.filter(
          (item) => item.service.id !== pdfResult.service.id,
        );
        return [pdfResult, ...filtered];
      });
      setHighlightedServiceId(pdfResult.service.id);
      setSelectedRecord(record);
      setScanRecord(null);
    } catch (error) {
      console.error("PDF ingest failed", error);
      setPdfError(
        error instanceof Error
          ? error.message
          : "Unable to analyze the uploaded PDF.",
      );
    } finally {
      setPdfLoading(false);
    }
  };

  const heroInfoVisible = !hasSearched;

  return (
    <div className="space-y-8">
      <section className="space-y-3 text-center">
        <Badge variant="slate" className="mx-auto w-fit">
          Mercy Networks
        </Badge>
        <h1 className="text-4xl font-serif font-semibold text-brand-heading">
          Find help, simply.
        </h1>
        <p className="mx-auto max-w-2xl text-base text-brand-muted">
          Mercy Networks helps people and caseworkers find the right support—from
          shelter and meals to housing programs—with one simple search. If we don’t
          have it yet, we’ll help you add it so everyone can discover it next time.
        </p>
      </section>

      <SearchBar
        query={query}
        onChange={handleQueryChange}
        onSubmit={handleSearch}
        isLoading={searchStatus === "loading"}
        showAdvanced={false}
      />

      <ChromeAiStatus
        status={builtInInterpreter.status}
        message={builtInInterpreter.statusMessage}
        lastRun={builtInInterpreter.lastRun}
        onRetry={builtInInterpreter.refresh}
        onRequestAccess={builtInInterpreter.requestAccess}
        lastError={builtInInterpreter.lastError}
      />

      {searchStatus === "error" && searchError && (
        <Card>
          <CardContent className="flex items-center gap-2 text-sm text-brand-orange">
            <Search className="h-4 w-4" aria-hidden="true" />
            {searchError}
          </CardContent>
        </Card>
      )}

      {heroInfoVisible && (
        <Card>
          <CardHeader>
            <CardTitle>How Mercy Networks works</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <InfoItem
              title="Ask for help"
              description="Tell us what you or someone you’re supporting needs. We understand plain language—no forms, no jargon."
            />
            <InfoItem
              title="See what’s available"
              description="Explore shelters, meals, medical care, and programs your team has already connected through Mercy Networks."
            />
            <InfoItem
              title="Add new connections"
              description="Found a new service? Add it from a website or PDF so others can find it next time."
            />
          </CardContent>
        </Card>
      )}

      {searchFilters && hasSearched && (
        <SearchUnderstandingPanel
          filters={searchFilters}
          isUpdating={searchStatus === "loading"}
          onFiltersChange={handleFiltersChange}
          onBroaden={handleBroadenSearch}
          onEditRequest={openFilterEditor}
        />
      )}

      {filterDraft && (
        <FilterEditor
          draft={filterDraft}
          onChange={setFilterDraft}
          onApply={applyFilterDraft}
          onCancel={closeFilterEditor}
        />
      )}

      {hasSearched && (
        <MatchingServicesList
          results={results}
          loadingRecordId={loadingRecordId}
          highlightedId={highlightedServiceId}
          onViewDetails={viewRecordDetails}
          isLoading={searchStatus === "loading"}
          showEmptyState={searchStatus === "success" && results.length === 0}
          onBroaden={handleBroadenSearch}
        />
      )}

      <WebSearchPanel
        query={webSearchQuery}
        onQueryChange={setWebSearchQuery}
        onSearch={() => {
          void executeWebSearch();
        }}
        results={webResults}
        status={webSearchStatus}
        error={webSearchError}
        onSelectResult={handleSelectWebResult}
        selectedResultId={selectedWebResult?.id ?? null}
        showPrompt={noServices}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ManualWebsiteCard
          url={manualWebsiteUrl}
          onUrlChange={(value) => {
            setManualWebsiteUrl(value);
            setManualWebsiteError(null);
          }}
          onSubmit={handleManualWebsiteIngest}
          isLoading={manualWebsiteLoading}
          error={manualWebsiteError}
        />
        <PdfIngestCard
          fileName={pdfFile?.name ?? ""}
          onFileChange={(event) =>
            handlePdfChange(event.target.files?.[0] ?? null)
          }
          onUpload={handlePdfUpload}
          isLoading={pdfLoading}
          error={pdfError}
        />
      </div>

      <WebPreviewPanel
        result={selectedWebResult}
        onClose={() => {
          setSelectedWebResult(null);
          setScanRecord(null);
          setScanError(null);
          setScanStatus("idle");
        }}
        onScan={handleScanSelectedWebsite}
        isScanning={scanStatus === "loading"}
        scanError={scanError}
        record={scanRecord}
      />

      {selectedRecord && (
        <div className="space-y-3">
          <h2 className="text-xl font-serif font-semibold text-brand-heading">
            Service details
          </h2>
          <EligibilityResult record={selectedRecord} />
        </div>
      )}
    </div>
  );
}

type ChromeAiStatusProps = {
  status: ReturnType<typeof useBuiltInAiInterpreter>["status"];
  message: string | null;
  lastRun: ReturnType<typeof useBuiltInAiInterpreter>["lastRun"];
  onRetry: () => Promise<void>;
  onRequestAccess: () => Promise<void>;
  lastError: string | null;
};

function ChromeAiStatus({
  status,
  message,
  lastRun,
  onRetry,
  onRequestAccess,
  lastError,
}: ChromeAiStatusProps) {
  const { badgeVariant, label, icon: Icon } = useMemo(() => {
    switch (status) {
      case "ready":
        return { badgeVariant: "success" as const, label: "Chrome AI ready", icon: Sparkles };
      case "permission-required":
        return {
          badgeVariant: "warning" as const,
          label: "Chrome AI locked",
          icon: Lock,
        };
      case "unavailable":
        return {
          badgeVariant: "slate" as const,
          label: "Chrome AI unavailable",
          icon: ShieldAlert,
        };
      case "error":
        return {
          badgeVariant: "warning" as const,
          label: "Chrome AI error",
          icon: ShieldAlert,
        };
      default:
        return {
          badgeVariant: "slate" as const,
          label: "Checking Chrome AI…",
          icon: Loader2,
        };
    }
  }, [status]);

  const action = useMemo(() => {
    if (status === "permission-required") {
      return { label: "Enable", handler: onRequestAccess };
    }
    if (status === "unavailable") {
      return { label: "Retry", handler: onRetry };
    }
    return null;
  }, [onRequestAccess, onRetry, status]);

  const infoText = useMemo(() => {
    if (lastError) {
      return lastError;
    }
    if (message) {
      return message;
    }
    if (lastRun === "fallback") {
      return "Using server interpretation for now.";
    }
    return null;
  }, [lastError, lastRun, message]);

  const shouldRender = status !== "ready" || infoText || lastRun === "fallback";
  if (!shouldRender) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-brand-muted">
      <Badge variant={badgeVariant} className="flex items-center gap-2">
        <Icon
          className={
            status === "checking"
              ? "h-3.5 w-3.5 animate-spin"
              : "h-3.5 w-3.5"
          }
          aria-hidden="true"
        />
        {label}
      </Badge>
      {infoText && <span>{infoText}</span>}
      {action && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void action.handler();
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

function SearchUnderstandingPanel({
  filters,
  onFiltersChange,
  onBroaden,
  onEditRequest,
  isUpdating,
}: {
  filters: InterpretedFilters;
  onFiltersChange: (filters: InterpretedFilters) => void;
  onBroaden: () => void;
  onEditRequest: () => void;
  isUpdating: boolean;
}) {
  const locationChips = (
    [
      { field: "locationCity" as const, label: filters.locationCity },
      { field: "locationCounty" as const, label: filters.locationCounty },
      {
        field: "state" as const,
        label: filters.state ? filters.state.toUpperCase() : null,
      },
    ] as const
  ).filter((chip) => chip.label);

  const hasSpecificFilters =
    locationChips.length > 0 ||
    filters.populations.length > 0 ||
    filters.needTypes.length > 0;

  const removeLocation = (
    field: "locationCity" | "locationCounty" | "state",
  ) => {
    onFiltersChange({
      ...filters,
      [field]: null,
    });
  };

  const removeValue = (field: "populations" | "needTypes", value: string) => {
    onFiltersChange({
      ...filters,
      [field]: filters[field].filter((item) => item !== value),
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-lg font-semibold text-brand-heading">
            Here’s how we understood your search
          </CardTitle>
          <p className="text-sm text-brand-muted">
            Adjust any of these chips or open the editor to fine-tune what you’re
            looking for.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBroaden}
            disabled={isUpdating || !hasSpecificFilters}
          >
            Broaden search
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onEditRequest}
            disabled={isUpdating}
            className="gap-2"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Edit filters
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="inline-flex items-center gap-2 text-sm text-brand-muted">
          <Badge variant="default" className="bg-brand-blue/10 text-brand-blue">
            Query: {filters.query}
          </Badge>
          {isUpdating && (
            <span className="inline-flex items-center gap-1 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Updating…
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {locationChips.map((chip) => (
            <RemovableChip
              key={`${chip.field}-${chip.label}`}
              label={`Location: ${chip.label}`}
              onRemove={() => removeLocation(chip.field)}
            />
          ))}
          {filters.populations.map((population) => (
            <RemovableChip
              key={`population-${population}`}
              label={`Helps: ${humanizeTag(population)}`}
              onRemove={() => removeValue("populations", population)}
            />
          ))}
          {filters.needTypes.map((need) => (
            <RemovableChip
              key={`need-${need}`}
              label={`Need: ${need}`}
              onRemove={() => removeValue("needTypes", need)}
            />
          ))}
          {!hasSpecificFilters && (
            <span className="text-sm text-brand-muted">
              We didn’t spot extra filters, so we’re leaning on the full-text match.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RemovableChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-border bg-white px-3 py-1 text-xs font-medium text-brand-heading shadow-sm">
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-brand-muted transition hover:text-brand-heading"
          aria-label={`Remove ${label}`}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function FilterEditor({
  draft,
  onChange,
  onApply,
  onCancel,
}: {
  draft: InterpretedFilters;
  onChange: (filters: InterpretedFilters) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<InterpretedFilters>) => {
    onChange({
      ...draft,
      ...patch,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-brand-heading">Fine-tune this search</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <LabeledField label="Search phrase">
            <Input
              value={draft.query}
              onChange={(event) => update({ query: event.target.value })}
              placeholder="Emergency shelter tonight"
            />
          </LabeledField>
          <LabeledField label="City">
            <Input
              value={draft.locationCity ?? ""}
              onChange={(event) =>
                update({ locationCity: event.target.value || null })
              }
              placeholder="Plano"
            />
          </LabeledField>
          <LabeledField label="County">
            <Input
              value={draft.locationCounty ?? ""}
              onChange={(event) =>
                update({ locationCounty: event.target.value || null })
              }
              placeholder="Dallas County"
            />
          </LabeledField>
          <LabeledField label="State">
            <Input
              value={draft.state ?? ""}
              onChange={(event) => update({ state: event.target.value || null })}
              placeholder="TX"
            />
          </LabeledField>
          <LabeledField label="Populations">
            <Input
              value={draft.populations.join(", ")}
              onChange={(event) =>
                update({ populations: splitList(event.target.value) })
              }
              placeholder="youth, families, veterans"
            />
          </LabeledField>
          <LabeledField label="Needs">
            <Input
              value={draft.needTypes.join(", ")}
              onChange={(event) =>
                update({ needTypes: splitList(event.target.value) })
              }
              placeholder="shelter, bed tonight, rapid rehousing"
            />
          </LabeledField>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onApply} className="gap-2">
            Apply filters
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block text-xs font-medium uppercase tracking-wide text-brand-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const MATCH_TIER_GROUPS: Array<{
  tier: "direct" | "broader" | "fuzzy";
  title: string;
  description: string;
}> = [
  {
    tier: "direct",
    title: "Best matches",
    description: "Strong text and filter matches for your search.",
  },
  {
    tier: "broader",
    title: "Other options near you",
    description: "Still relevant, but with looser filters or nearby regions.",
  },
  {
    tier: "fuzzy",
    title: "Broader / fuzzy matches",
    description: "Services with similar wording when nothing else is close.",
  },
];

function MatchingServicesList({
  results,
  loadingRecordId,
  highlightedId,
  onViewDetails,
  isLoading,
  showEmptyState,
  onBroaden,
}: {
  results: SearchResultItem[];
  loadingRecordId: string | null;
  highlightedId: string | null;
  onViewDetails: (id: string) => void;
  isLoading: boolean;
  showEmptyState: boolean;
  onBroaden: () => void;
}) {
  const groups = MATCH_TIER_GROUPS.map((group) => ({
    ...group,
    items: results.filter((result) => result.matchTier === group.tier),
  })).filter((group) => group.items.length > 0);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div>
          <CardTitle className="text-lg text-brand-heading">
            Matching services from your library
          </CardTitle>
          <p className="text-sm text-brand-muted">
            We surface the fastest database matches first. Web results and other
            ideas stay available below.
          </p>
        </div>
        {isLoading && (
          <span className="inline-flex items-center gap-2 text-xs text-brand-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Refreshing…
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && <ResultSkeleton />}
        {groups.map((group) => (
          <div key={group.tier} className="space-y-3">
            <div>
              <h3 className="text-base font-semibold text-brand-heading">
                {group.title}
              </h3>
              <p className="text-xs text-brand-muted">{group.description}</p>
            </div>
            <div className="space-y-3">
              {group.items.map((item) => (
                <ResultCard
                  key={item.service.id}
                  result={item}
                  highlighted={item.service.id === highlightedId}
                  loading={loadingRecordId === item.service.id}
                  onViewDetails={() => onViewDetails(item.service.id)}
                />
              ))}
            </div>
          </div>
        ))}

        {showEmptyState && !isLoading && (
          <div className="rounded-2xl border border-dashed border-brand-border bg-brand-background p-6 text-sm text-brand-muted">
            <p className="font-medium text-brand-heading">
              We didn’t find a service that fits this search yet.
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <button
                  type="button"
                  onClick={onBroaden}
                  className="text-brand-blue underline decoration-dotted underline-offset-4 hover:text-brand-heading"
                >
                  Broaden the search filters
                </button>{" "}
                to include nearby or more flexible options.
              </li>
              <li>Check the Web Explorer below for fresh results.</li>
              <li>Add a new program from a website or PDF to teach Mercy Networks.</li>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResultCard({
  result,
  highlighted,
  loading,
  onViewDetails,
}: {
  result: SearchResultItem;
  highlighted: boolean;
  loading: boolean;
  onViewDetails: () => void;
}) {
  const { service, matchReason, matchTier } = result;
  const location = formatLocation(service);
  const sourceLabel =
    service.sourceType === "pdf" ? "Added from PDF" : "Added from website";

  return (
    <div
      className={`rounded-2xl border bg-white p-5 shadow-sm transition ${highlighted ? "border-brand-green shadow-md" : "border-brand-border"}`}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-brand-muted">
            <Badge variant="default">
              {service.sourceType === "pdf" ? (
                <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Globe className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              )}
              {sourceLabel}
            </Badge>
            <Badge variant="slate" className="uppercase tracking-wide">
              {matchTier === "direct"
                ? "Best match"
                : matchTier === "broader"
                  ? "Broader match"
                  : "Fuzzy match"}
            </Badge>
            {service.sourceUrl && (
              <a
                href={service.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-brand-blue underline decoration-dotted underline-offset-4 hover:text-brand-heading"
              >
                Open source
              </a>
            )}
            {service.createdAt && (
              <span>Updated {new Date(service.createdAt).toLocaleDateString()}</span>
            )}
          </div>
          <h4 className="text-lg font-semibold text-brand-heading">
            {service.programName || service.pageTitle || "Service name coming soon"}
          </h4>
          {location && <p className="text-sm text-brand-muted">{location}</p>}
          {matchReason.length > 0 && (
            <p className="text-xs text-brand-blue">
              Match highlights: {matchReason.join(" · ")}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={onViewDetails}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading…
            </>
          ) : (
            <>
              View details
              <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
            </>
          )}
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {service.populations.length > 0 ? (
          service.populations.map((population) => (
            <Badge key={population} variant="slate">
              {humanizeTag(population)}
            </Badge>
          ))
        ) : (
          <Badge variant="slate">Anyone welcome</Badge>
        )}
        {service.needTypes.map((need) => (
          <Badge key={need} variant="slate">
            Need: {need}
          </Badge>
        ))}
      </div>
      <p className="mt-4 line-clamp-3 text-sm text-brand-muted">
        {service.previewEligibilityText.trim().length
          ? service.previewEligibilityText
          : "We’re still gathering details for this service."}
      </p>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-2xl border border-brand-border bg-white p-5"
        >
          <div className="h-4 w-24 rounded-full bg-brand-border/60" />
          <div className="mt-3 h-5 w-2/3 rounded-full bg-brand-border/60" />
          <div className="mt-4 flex gap-2">
            <span className="h-6 w-20 rounded-full bg-brand-border/40" />
            <span className="h-6 w-24 rounded-full bg-brand-border/40" />
          </div>
          <div className="mt-4 h-4 w-full rounded-full bg-brand-border/40" />
          <div className="mt-2 h-4 w-5/6 rounded-full bg-brand-border/40" />
        </div>
      ))}
    </div>
  );
}

function formatLocation(service: ServiceSummary) {
  const parts = [service.locationCity, service.locationCounty, service.locationState]
    .map((part) => part?.toString().trim())
    .filter((part) => part && part.length > 0) as string[];
  return parts.join(", ");
}

function humanizeTag(value: string) {
  return value.replace(/_/g, " ");
}

function WebSearchPanel({
  query,
  onQueryChange,
  onSearch,
  results,
  status,
  error,
  onSelectResult,
  selectedResultId,
  showPrompt,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  results: WebResult[];
  status: SearchStatus;
  error: string | null;
  onSelectResult: (result: WebResult) => void;
  selectedResultId: string | null;
  showPrompt: boolean;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle className="text-brand-heading">
          {showPrompt ? "Didn’t find what you need? Explore the web" : "Explore the web"}
        </CardTitle>
        <p className="text-sm text-brand-muted">
          We’ll show official program pages right here so you can preview them and
          save anything useful without leaving the site.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 md:flex-row">
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search the web for this need…"
            className="md:flex-1"
          />
          <Button onClick={onSearch} disabled={status === "loading"} className="gap-2">
            {status === "loading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Searching…
              </>
            ) : (
              <>
                <Search className="h-4 w-4" aria-hidden="true" />
                Search the web from here
              </>
            )}
          </Button>
        </div>
        {error && <p className="text-sm text-brand-orange">{error}</p>}
        <div className="space-y-3">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => onSelectResult(result)}
              className={`w-full text-left transition ${result.id === selectedResultId ? "rounded-2xl border border-brand-heading/40 bg-white p-4 shadow" : "rounded-2xl border border-brand-border bg-white p-4 hover:border-brand-heading/40"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-base font-semibold text-brand-heading">
                  {result.title}
                </p>
                <span className="text-xs text-brand-muted">{result.displayUrl}</span>
              </div>
              <p className="mt-2 text-sm text-brand-muted">{result.snippet}</p>
              <div className="mt-3 inline-flex items-center gap-1 text-sm text-brand-blue">
                Preview this site
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </div>
            </button>
          ))}
          {status === "success" && results.length === 0 && (
            <p className="text-sm text-brand-muted">
              No public results yet. Try another phrase or add a site manually below.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function WebPreviewPanel({
  result,
  onClose,
  onScan,
  isScanning,
  scanError,
  record,
}: {
  result: WebResult | null;
  onClose: () => void;
  onScan: () => void;
  isScanning: boolean;
  scanError: string | null;
  record: EligibilityRecordDetail | null;
}) {
  if (!result) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle className="text-brand-heading">{result.title}</CardTitle>
          <p className="text-sm text-brand-muted">{result.displayUrl}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={() => window.open(result.url, "_blank", "noopener,noreferrer")}
          >
            Open site
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-[400px] w-full overflow-hidden rounded-2xl border border-brand-border bg-brand-background">
          <iframe
            src={result.url}
            title={result.title}
            className="h-full w-full"
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
          />
        </div>
        <div className="space-y-2">
          <Button onClick={onScan} disabled={isScanning} className="w-full gap-2">
            {isScanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Scanning this website…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Scan this page for service details
              </>
            )}
          </Button>
          <p className="text-xs text-brand-muted">
            We’ll read the page, pull out who the service helps, and store it so it
            appears in future searches.
          </p>
          {scanError && <p className="text-sm text-brand-orange">{scanError}</p>}
        </div>
        {record && <EligibilityResult record={record} />}
      </CardContent>
    </Card>
  );
}

function ManualWebsiteCard({
  url,
  onUrlChange,
  onSubmit,
  isLoading,
  error,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-brand-heading">
          <Globe className="h-5 w-5" aria-hidden="true" />
          Already have a link?
        </CardTitle>
        <p className="text-sm text-brand-muted">
          Paste a public webpage that describes a shelter, program, or resource. We’ll
          scan it for who it helps, where it is, and what someone needs to get in.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="https://example.org/program/intake"
          type="url"
        />
        {error && <p className="text-xs text-brand-orange">{error}</p>}
        <Button onClick={onSubmit} disabled={isLoading} className="w-full gap-2">
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Scanning website…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Scan this website for service details
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function PdfIngestCard({
  fileName,
  onFileChange,
  onUpload,
  isLoading,
  error,
}: {
  fileName: string;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-brand-heading">
          <FileText className="h-5 w-5" aria-hidden="true" />
          Have a flyer or packet?
        </CardTitle>
        <p className="text-sm text-brand-muted">
          Upload a PDF and we’ll pull out who the service helps and what’s required,
          then save it for future searches.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input type="file" accept="application/pdf" onChange={onFileChange} />
        {fileName && (
          <p className="text-xs text-brand-muted">
            Selected file: <span className="font-medium text-brand-heading">{fileName}</span>
          </p>
        )}
        {error && <p className="text-xs text-brand-orange">{error}</p>}
        <Button onClick={onUpload} disabled={isLoading} className="w-full gap-2">
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Scanning PDF…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Scan this PDF for service details
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function InfoItem({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-brand-border bg-brand-background p-4">
      <h3 className="text-base font-semibold text-brand-heading">{title}</h3>
      <p className="mt-2 text-sm text-brand-muted">{description}</p>
    </div>
  );
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function cloneFilters(filters: InterpretedFilters): InterpretedFilters {
  return {
    query: filters.query,
    locationCity: filters.locationCity,
    locationCounty: filters.locationCounty,
    state: filters.state,
    populations: [...filters.populations],
    needTypes: [...filters.needTypes],
  };
}

function formatFiltersForRequest(filters: InterpretedFilters) {
  return {
    locationCity: filters.locationCity ?? undefined,
    locationCounty: filters.locationCounty ?? undefined,
    state: filters.state ?? undefined,
    populations: filters.populations,
    needTypes: filters.needTypes,
  };
}

function normalizeIngestPayload(payload: any): IngestPayload {
  const base = payload?.record ?? payload;
  const eligibility: Eligibility | undefined = base?.eligibility;

  if (!eligibility) {
    throw new Error("Missing eligibility details in ingest response.");
  }

  const record: EligibilityRecordDetail = {
    id: String(base.id),
    programName: base.programName ?? null,
    sourceType: base.sourceType === "web" ? "web" : "pdf",
    sourceUrl: base.sourceUrl ?? null,
    pageTitle: base.pageTitle ?? null,
    rawEligibilityText: base.rawEligibilityText ?? "",
    rawTextSnippet: base.rawTextSnippet ?? base.rawEligibilityText ?? "",
    eligibility,
    createdAt:
      typeof base.createdAt === "string"
        ? base.createdAt
        : base.createdAt
            ? new Date(base.createdAt).toISOString()
            : new Date().toISOString(),
    locationCity: base.locationCity ?? null,
    locationCounty: base.locationCounty ?? null,
    locationState: base.locationState ?? null,
  };

  const servicePayload = payload?.service ?? {};

  const service: ServiceSummary = {
    id: String(servicePayload.id ?? record.id),
    programName: servicePayload.programName ?? record.programName,
    sourceType:
      servicePayload.sourceType === "web" || record.sourceType === "web"
        ? "web"
        : "pdf",
    sourceUrl: servicePayload.sourceUrl ?? record.sourceUrl,
    pageTitle: servicePayload.pageTitle ?? record.pageTitle,
    createdAt: servicePayload.createdAt ?? record.createdAt,
    previewEligibilityText:
      servicePayload.previewEligibilityText ??
      snippet(record.rawEligibilityText, 220),
    locationCity: servicePayload.locationCity ?? record.locationCity ?? null,
    locationCounty:
      servicePayload.locationCounty ?? record.locationCounty ?? null,
    locationState:
      servicePayload.locationState ?? record.locationState ?? null,
    populations: Array.isArray(servicePayload.populations)
      ? servicePayload.populations
      : eligibility.population ?? [],
    needTypes: Array.isArray(servicePayload.needTypes)
      ? servicePayload.needTypes
      : eligibility.requirements ?? [],
  };

  const result: SearchResultItem = {
    service,
    matchReason: ["Saved just now"],
    matchTier: "direct",
  };

  return { record, result };
}

function urlsMatch(a: string, b: string) {
  try {
    const first = new URL(a);
    const second = new URL(b);
    return first.origin === second.origin && first.pathname === second.pathname;
  } catch {
    return a === b;
  }
}

function extractTitleFromHtml(html: string) {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return null;
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const title = doc.querySelector("title");
  return title?.textContent?.trim() || null;
}

function extractVisibleTextFromHtml(html: string) {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return html;
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  const text = doc.body?.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function snippet(text: string, length: number) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= length) {
    return cleaned;
  }
  return `${cleaned.slice(0, length)}…`;
}
