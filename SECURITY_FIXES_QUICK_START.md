# Security Fixes Quick Start Guide

This guide provides immediate, actionable steps to address the critical and high-severity vulnerabilities identified in the security audit.

## 🔴 CRITICAL - Fix Immediately

### 1. Enable SSL Certificate Validation

**File:** `db/index.ts`

**Current Code (line 32-36):**
```typescript
ssl:
  process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }  // VULNERABLE
    : undefined,
```

**Fixed Code:**
```typescript
ssl:
  process.env.NODE_ENV === "production"
    ? {
        rejectUnauthorized: true,
        ca: process.env.DATABASE_CA_CERT // Optional: if using custom CA
      }
    : undefined,
```

**Test:** Ensure your database connection still works after this change.

---

### 2. Implement Basic Authentication

Create a new middleware file to protect all API routes.

**File:** Create `middleware.ts` in the root directory

```typescript
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Simple API key authentication
// IMPORTANT: Replace with proper auth system (NextAuth, JWT, etc.)
const VALID_API_KEYS = (process.env.API_KEYS || '').split(',').filter(Boolean)

export function middleware(request: NextRequest) {
  // Skip auth for GET /api/eligibility-records (if you want it public)
  // Remove this if you want all endpoints protected
  if (request.method === 'GET' && request.nextUrl.pathname === '/api/eligibility-records') {
    return NextResponse.next()
  }

  // Check for API key in header
  const apiKey = request.headers.get('x-api-key')

  if (!apiKey || !VALID_API_KEYS.includes(apiKey)) {
    return NextResponse.json(
      { error: 'Unauthorized - Valid API key required' },
      { status: 401 }
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*'
}
```

**Environment Variable:**
Add to `.env.local`:
```
API_KEYS=your-secret-api-key-here,another-key-if-needed
```

**Usage:**
```bash
curl -H "x-api-key: your-secret-api-key-here" \
  -X POST http://localhost:3000/api/parse-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

---

## 🟠 HIGH - Fix Within 24 Hours

### 3. Prevent SSRF Attacks

**File:** `app/api/parse-url/route.ts`

Add this helper function at the top of the file:

```typescript
const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata
  'metadata.google.internal', // GCP metadata
];

function isAllowedUrl(url: URL): { allowed: boolean; error?: string } {
  // Check protocol
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      allowed: false,
      error: `Protocol ${url.protocol} not allowed. Only HTTP and HTTPS are supported.`
    };
  }

  // Block localhost and loopback
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(hostname)) {
    return {
      allowed: false,
      error: 'Access to local resources is not permitted.'
    };
  }

  // Block private IP ranges
  // 10.0.0.0/8
  if (/^10\./.test(hostname)) {
    return { allowed: false, error: 'Private IP range not allowed.' };
  }

  // 172.16.0.0/12
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) {
    return { allowed: false, error: 'Private IP range not allowed.' };
  }

  // 192.168.0.0/16
  if (/^192\.168\./.test(hostname)) {
    return { allowed: false, error: 'Private IP range not allowed.' };
  }

  // Block link-local addresses (169.254.0.0/16)
  if (/^169\.254\./.test(hostname)) {
    return { allowed: false, error: 'Link-local addresses not allowed.' };
  }

  return { allowed: true };
}
```

**Update the POST function (around line 23-32):**

```typescript
let normalizedUrl: URL;

try {
  normalizedUrl = new URL(body.url);
} catch {
  return NextResponse.json(
    { error: "The provided URL is not valid." },
    { status: 400 },
  );
}

// ADD THIS VALIDATION
const validation = isAllowedUrl(normalizedUrl);
if (!validation.allowed) {
  return NextResponse.json(
    { error: validation.error || "URL not allowed" },
    { status: 400 }
  );
}

// Add timeout to fetch (around line 34)
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

try {
  const response = await fetch(normalizedUrl, {
    signal: controller.signal, // ADD THIS
    method: "GET",
    headers: {
      "User-Agent":
        "EligibilityIngestorBot/1.0 (+https://pdf-parser-git-main-macleanlukes-projects.vercel.app/)",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  clearTimeout(timeoutId); // ADD THIS

  // ... rest of existing code
} catch (error) {
  clearTimeout(timeoutId); // ADD THIS

  // Handle timeout specifically
  if (error.name === 'AbortError') {
    return NextResponse.json(
      { error: "Request timeout - server took too long to respond" },
      { status: 504 }
    );
  }

  console.error("Failed to parse eligibility from URL", error);
  return NextResponse.json(
    { error: "Failed to analyze the provided URL. Please try again." },
    { status: 500 }
  );
}
```

---

### 4. Implement Rate Limiting

**Option A: Using Vercel (Recommended for Vercel deployments)**

Install Upstash Redis and rate limiting:
```bash
npm install @upstash/redis @upstash/ratelimit
```

Create `lib/rate-limit.ts`:
```typescript
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Create a new ratelimiter that allows 10 requests per hour
export const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "1 h"),
  analytics: true,
  prefix: "@upstash/ratelimit",
});

export async function checkRateLimit(identifier: string) {
  const { success, limit, reset, remaining } = await ratelimit.limit(identifier);

  return { success, limit, reset, remaining };
}
```

Add to environment variables:
```
UPSTASH_REDIS_REST_URL=your-url
UPSTASH_REDIS_REST_TOKEN=your-token
```

**Option B: Simple In-Memory Rate Limiting (for testing/development)**

Create `lib/simple-rate-limit.ts`:
```typescript
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(
  identifier: string,
  maxRequests: number = 10,
  windowMs: number = 3600000 // 1 hour
): { success: boolean; remaining: number; reset: number } {
  const now = Date.now();
  const record = requestCounts.get(identifier);

  // Clean up old entries
  if (record && now > record.resetTime) {
    requestCounts.delete(identifier);
  }

  if (!record || now > record.resetTime) {
    // First request or window expired
    requestCounts.set(identifier, {
      count: 1,
      resetTime: now + windowMs,
    });

    return {
      success: true,
      remaining: maxRequests - 1,
      reset: now + windowMs,
    };
  }

  // Increment count
  record.count++;

  if (record.count > maxRequests) {
    return {
      success: false,
      remaining: 0,
      reset: record.resetTime,
    };
  }

  return {
    success: true,
    remaining: maxRequests - record.count,
    reset: record.resetTime,
  };
}
```

**Update API routes to use rate limiting:**

Example for `app/api/parse-eligibility/route.ts`:

```typescript
import { checkRateLimit } from "@/lib/simple-rate-limit"; // or "@/lib/rate-limit"

export async function POST(request: NextRequest) {
  // Get IP address for rate limiting
  const ip = request.ip ?? request.headers.get("x-forwarded-for") ?? "127.0.0.1";

  const rateLimitResult = await checkRateLimit(ip);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded. Please try again later.",
        reset: new Date(rateLimitResult.reset).toISOString(),
      },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateLimitResult.reset.toString(),
        },
      }
    );
  }

  // ... rest of existing code
}
```

Apply to all POST routes:
- `app/api/parse-eligibility/route.ts`
- `app/api/parse-url/route.ts`
- `app/api/search-eligibility/route.ts`
- `app/api/web-search/route.ts`

---

### 5. Improve File Upload Validation

**File:** `app/api/parse-eligibility/route.ts`

Add after getting the buffer (around line 32):

```typescript
const arrayBuffer = await file.arrayBuffer();
const buffer = Buffer.from(arrayBuffer);

// ADD THESE VALIDATIONS:

// 1. Enforce size limit
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
if (buffer.length > MAX_FILE_SIZE) {
  return NextResponse.json(
    { error: "File too large. Maximum size is 10MB." },
    { status: 413 }
  );
}

// 2. Verify PDF magic number (already exists in pdf-parser, but add here too)
const pdfHeader = buffer.slice(0, 4).toString();
if (pdfHeader !== '%PDF') {
  return NextResponse.json(
    { error: "Invalid PDF file format." },
    { status: 400 }
  );
}

// 3. Sanitize filename
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 255);
}

// Use sanitized filename when storing
const sanitizedFilename = sanitizeFilename(file.name);
```

Update the database insert to use `sanitizedFilename` instead of `file.name`.

---

### 6. Add Security Headers

**File:** Create or update `next.config.mjs`

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'fs': 'fs'
      });
    }
    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse']
  },

  // ADD SECURITY HEADERS
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
```

For Content-Security-Policy, create `middleware.ts` (or update if you created it for auth):

```typescript
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // Add Content Security Policy
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' https://api.openai.com https://www.googleapis.com;"
  )

  return response
}

export const config = {
  matcher: '/:path*'
}
```

---

## 🟡 MEDIUM - Fix Within 1 Week

### 7. Add Input Validation Limits

**File:** `lib/search-filter.ts`

Update the schema to add limits:

```typescript
export const searchFilterSchema = z.object({
  textQuery: z.string().max(200).default(""),
  populations: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  locations: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  requirementsInclude: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  genderRestriction: z.enum(genderRestrictions).nullable().default(null),
});
```

---

### 8. Fix Error Message Disclosure

**File:** `app/api/web-search/route.ts` (line 32-40)

Replace:
```typescript
if (!GOOGLE_CSE_ID || !GOOGLE_CSE_KEY) {
  console.error("Web search attempted without GOOGLE_CSE_ID/KEY");
  return NextResponse.json(
    {
      error: "Web search is not configured. Please provide GOOGLE_CSE_ID and GOOGLE_CSE_KEY in the environment.",
    },
    { status: 500 }
  );
}
```

With:
```typescript
if (!GOOGLE_CSE_ID || !GOOGLE_CSE_KEY) {
  console.error("Web search attempted without GOOGLE_CSE_ID/KEY");
  return NextResponse.json(
    { error: "Web search is currently unavailable." },
    { status: 503 }
  );
}
```

---

## Testing Your Fixes

### 1. Test SSL Certificate Validation
```bash
# Connection should work with valid certificates
npm run dev
# Check logs for any SSL errors
```

### 2. Test Authentication
```bash
# Should fail without API key
curl http://localhost:3000/api/parse-url -d '{"url":"https://example.com"}'

# Should succeed with API key
curl -H "x-api-key: your-key" http://localhost:3000/api/parse-url \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

### 3. Test SSRF Protection
```bash
# Should be blocked
curl -H "x-api-key: your-key" http://localhost:3000/api/parse-url \
  -H "Content-Type: application/json" \
  -d '{"url":"http://localhost:3000"}'

curl -H "x-api-key: your-key" http://localhost:3000/api/parse-url \
  -H "Content-Type: application/json" \
  -d '{"url":"http://169.254.169.254"}'

# Should work
curl -H "x-api-key: your-key" http://localhost:3000/api/parse-url \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

### 4. Test Rate Limiting
```bash
# Run this 11 times - the 11th should fail with 429
for i in {1..11}; do
  curl -H "x-api-key: your-key" http://localhost:3000/api/parse-url \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com"}'
  echo "Request $i"
done
```

---

## Deployment Checklist

Before deploying to production:

- [ ] SSL certificate validation enabled
- [ ] Authentication implemented and tested
- [ ] SSRF protection added to `/api/parse-url`
- [ ] Rate limiting configured
- [ ] Security headers added
- [ ] Environment variables set:
  - [ ] `API_KEYS` (for authentication)
  - [ ] `DATABASE_URL` (with SSL support)
  - [ ] `OPENAI_API_KEY`
  - [ ] `UPSTASH_REDIS_REST_URL` (if using Vercel rate limiting)
  - [ ] `UPSTASH_REDIS_REST_TOKEN` (if using Vercel rate limiting)
- [ ] File upload validation tested
- [ ] Error messages reviewed (no sensitive info)
- [ ] Run `npm audit` and fix vulnerabilities
- [ ] Test all critical endpoints

---

## Additional Recommendations

1. **Set up monitoring:** Use services like Sentry, LogRocket, or Datadog
2. **Enable audit logging:** Log all API access with IP, timestamp, and action
3. **Implement CORS properly:** If you have a frontend on a different domain
4. **Regular security updates:** Run `npm audit` weekly
5. **Penetration testing:** Hire a security firm or use automated tools

---

## Getting Help

If you encounter issues while implementing these fixes:

1. Review the full security audit report: `SECURITY_AUDIT_REPORT.md`
2. Check Next.js documentation: https://nextjs.org/docs
3. Review Vercel security best practices: https://vercel.com/docs/security
4. Test in development before deploying to production

---

**Last Updated:** January 12, 2026
