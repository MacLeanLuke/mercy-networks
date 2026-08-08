"use client";

import { generateObject, type CoreMessage, type LanguageModelV1 } from "ai";
import { z } from "zod";

export type BrowserGenerateObjectOptions<T> = {
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  messages: CoreMessage[];
};

export type BrowserAiReadyProvider = {
  generateObject: <T>(
    options: BrowserGenerateObjectOptions<T>,
  ) => Promise<{ object: T }>;
};

export type BrowserAiProviderState =
  | { status: "ready"; provider: BrowserAiReadyProvider }
  | {
      status: "permission-required";
      reason?: string;
      requestAccess: () => Promise<BrowserAiProviderState>;
    }
  | { status: "unavailable"; reason: string };

type CommunityFactory = ((options?: { model?: string }) => LanguageModelV1) | null;

/**
 * Keyed on the `window.ai` object rather than held as a single module-level
 * instance. A plain singleton captured whichever `ai` existed on the first call
 * and never released it, so a provider built before the user granted permission
 * kept serving a dead session afterwards.
 */
const providerCache = new WeakMap<object, BrowserAiReadyProvider>();
let communityFactory: CommunityFactory | undefined;

export async function createBrowserAiProvider(): Promise<BrowserAiProviderState> {
  if (typeof window === "undefined") {
    return {
      status: "unavailable",
      reason: "Chrome built-in AI can only run in the browser.",
    };
  }

  const ai = window.ai;
  if (!ai?.canCreateTextSession || !ai.createTextSession) {
    return {
      status: "unavailable",
      reason: "Chrome built-in AI is not exposed in this browser.",
    };
  }

  try {
    const capability = await ai.canCreateTextSession();
    if (!capability || capability.available === "no") {
      return {
        status: "unavailable",
        reason:
          capability?.reason ??
          "Chrome built-in AI is unavailable on this device.",
      };
    }

    if (capability.available === "after-user-interaction") {
      return {
        status: "permission-required",
        reason:
          capability.reason ??
          "Chrome needs your permission to use the built-in model.",
        requestAccess: async () => {
          try {
            const session = await ai.createTextSession();
            session.destroy?.();
            return {
              status: "ready",
              provider: getOrCreateProvider(ai),
            };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Chrome built-in AI permission was denied.";
            return {
              status: "unavailable",
              reason: message,
            };
          }
        },
      };
    }

    return {
      status: "ready",
      provider: getOrCreateProvider(ai),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to check Chrome built-in AI availability.";
    return {
      status: "unavailable",
      reason: message,
    };
  }
}

function getOrCreateProvider(ai: NonNullable<typeof window.ai>) {
  const cached = providerCache.get(ai);
  if (cached) {
    return cached;
  }

  const provider: BrowserAiReadyProvider = {
    async generateObject<T>({ schema, messages }: BrowserGenerateObjectOptions<T>) {
      const viaCommunity = await tryCommunityGenerate({ schema, messages });
      if (viaCommunity) {
        return viaCommunity;
      }

      const prompt = formatMessages(messages);
      const session = await ai.createTextSession();

      try {
        const response = await session.prompt(prompt);
        const parsed = parseStructuredObject(response, schema);
        return { object: parsed };
      } finally {
        session.destroy?.();
      }
    },
  };

  providerCache.set(ai, provider);
  return provider;
}

async function tryCommunityGenerate<T>({
  schema,
  messages,
}: BrowserGenerateObjectOptions<T>): Promise<{ object: T } | null> {
  const factory = await ensureCommunityFactory();
  if (!factory) {
    return null;
  }

  try {
    const model = factory({ model: "text" });
    const result = await generateObject({
      model,
      schema,
      messages,
    });
    return result as { object: T };
  } catch (error) {
    console.warn("Community built-in AI provider failed", error);
    return null;
  }
}

async function ensureCommunityFactory(): Promise<CommunityFactory> {
  if (communityFactory !== undefined) {
    return communityFactory;
  }

  try {
    const moduleId = "@ai-sdk/built-in-ai";
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier);",
    ) as (specifier: string) => Promise<any>;
    const mod: any = await dynamicImport(moduleId);
    const factory = mod?.builtInAi ?? mod?.default;
    communityFactory = typeof factory === "function" ? factory : null;
  } catch (error) {
    console.warn("Unable to load community built-in AI provider", error);
    communityFactory = null;
  }

  return communityFactory ?? null;
}

function formatMessages(messages: CoreMessage[]) {
  return messages
    .map((message) => {
      const prefix =
        message.role === "system"
          ? "System"
          : message.role === "user"
            ? "User"
            : "Assistant";
      return `${prefix}: ${message.content}`;
    })
    .join("\n\n");
}

function parseStructuredObject<T>(value: string, schema: z.ZodType<T>): T {
  const json = extractJsonFromResponse(value);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      parsed.error.errors
        .map((issue) => issue.message)
        .join("; ") || "Invalid structured response",
    );
  }

  return parsed.data;
}

function extractJsonFromResponse(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Chrome AI returned an empty response");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // fallthrough
      }
    }
    throw new Error("Chrome AI response did not contain valid JSON");
  }
}
