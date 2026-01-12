import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Simple API key authentication
// For production: Consider using NextAuth.js, JWT, or OAuth
const VALID_API_KEYS = (process.env.API_KEYS || "")
  .split(",")
  .filter(Boolean)
  .map((key) => key.trim());

// Public endpoints that don't require authentication
const PUBLIC_ENDPOINTS = [
  "/api/health", // Health check endpoint (if you add one)
];

// Read-only endpoints that might be public (configure as needed)
const READ_ONLY_PUBLIC = process.env.ALLOW_PUBLIC_READ === "true";

function isPublicEndpoint(pathname: string): boolean {
  return PUBLIC_ENDPOINTS.some((endpoint) => pathname.startsWith(endpoint));
}

function isReadOnlyEndpoint(pathname: string, method: string): boolean {
  // Allow public read access to eligibility records if configured
  return (
    READ_ONLY_PUBLIC &&
    method === "GET" &&
    pathname.startsWith("/api/eligibility-records")
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // Only apply to API routes
  if (!pathname.startsWith("/api")) {
    return addSecurityHeaders(NextResponse.next());
  }

  // Check if endpoint is public
  if (isPublicEndpoint(pathname) || isReadOnlyEndpoint(pathname, method)) {
    return addSecurityHeaders(NextResponse.next());
  }

  // Check for API key in header
  const apiKey = request.headers.get("x-api-key");

  if (!apiKey || !VALID_API_KEYS.includes(apiKey)) {
    return NextResponse.json(
      {
        error: "Unauthorized - Valid API key required",
        message:
          "Please provide a valid API key in the 'x-api-key' header. Contact the administrator to obtain an API key.",
      },
      { status: 401 },
    );
  }

  // API key is valid, continue with security headers
  return addSecurityHeaders(NextResponse.next());
}

function addSecurityHeaders(response: NextResponse): NextResponse {
  // Content Security Policy
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' https://api.openai.com https://www.googleapis.com;",
  );

  // Prevent clickjacking
  response.headers.set("X-Frame-Options", "DENY");

  // Prevent MIME sniffing
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Referrer Policy
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // XSS Protection (legacy, but still useful)
  response.headers.set("X-XSS-Protection", "1; mode=block");

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (public directory)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*|api/health).*)",
    "/api/:path*",
  ],
};
