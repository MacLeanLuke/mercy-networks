/**
 * Simple in-memory rate limiter
 * For production with multiple instances, consider using Redis/Upstash
 */

type RateLimitRecord = {
  count: number;
  resetTime: number;
};

// Store rate limit records in memory
const requestCounts = new Map<string, RateLimitRecord>();

// Clean up old entries every hour
setInterval(
  () => {
    const now = Date.now();
    Array.from(requestCounts.entries()).forEach(([key, record]) => {
      if (now > record.resetTime) {
        requestCounts.delete(key);
      }
    });
  },
  60 * 60 * 1000,
); // 1 hour

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  reset: number;
  limit: number;
};

/**
 * Check if a request should be rate limited
 * @param identifier - Unique identifier (usually IP address)
 * @param maxRequests - Maximum number of requests allowed in the window
 * @param windowMs - Time window in milliseconds
 * @returns RateLimitResult with success status and metadata
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number = 10,
  windowMs: number = 3600000, // 1 hour default
): RateLimitResult {
  const now = Date.now();
  const record = requestCounts.get(identifier);

  // Clean up expired record
  if (record && now > record.resetTime) {
    requestCounts.delete(identifier);
  }

  if (!record || now > record.resetTime) {
    // First request or window expired
    const resetTime = now + windowMs;
    requestCounts.set(identifier, {
      count: 1,
      resetTime,
    });

    return {
      success: true,
      remaining: maxRequests - 1,
      reset: resetTime,
      limit: maxRequests,
    };
  }

  // Increment count
  record.count++;

  if (record.count > maxRequests) {
    return {
      success: false,
      remaining: 0,
      reset: record.resetTime,
      limit: maxRequests,
    };
  }

  return {
    success: true,
    remaining: maxRequests - record.count,
    reset: record.resetTime,
    limit: maxRequests,
  };
}

/**
 * Rate limit configurations for different endpoint types
 */
export const RATE_LIMITS = {
  // File uploads: 5 per hour (expensive operation)
  FILE_UPLOAD: {
    maxRequests: 5,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // URL parsing: 10 per hour (external fetch)
  URL_PARSE: {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // AI search: 20 per hour (AI API calls)
  AI_SEARCH: {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Web search: 15 per hour (Google API)
  WEB_SEARCH: {
    maxRequests: 15,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Record retrieval: 100 per hour (read operations)
  RECORD_READ: {
    maxRequests: 100,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
} as const;

/**
 * Get the client IP address from the request
 * @param request - NextRequest object
 * @returns IP address string
 */
export function getClientIp(request: Request): string {
  const headers = request.headers;

  // Try various headers that might contain the real IP
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    // x-forwarded-for may contain multiple IPs, take the first one
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  // Fallback to a default (this will group all requests without IP info)
  return "unknown";
}
