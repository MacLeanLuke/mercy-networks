/**
 * URL validation and SSRF protection utilities
 */

const ALLOWED_PROTOCOLS = ["http:", "https:"];

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "::ffff:127.0.0.1",
  // AWS metadata endpoints
  "169.254.169.254",
  "169.254.170.2",
  // GCP metadata
  "metadata.google.internal",
  "metadata",
  // Azure metadata
  "169.254.169.254",
  // DigitalOcean metadata
  "169.254.169.254",
];

type UrlValidationResult = {
  allowed: boolean;
  error?: string;
};

/**
 * Check if a URL is allowed (SSRF protection)
 * @param url - URL object to validate
 * @returns Validation result with allowed status and optional error message
 */
export function isAllowedUrl(url: URL): UrlValidationResult {
  // Check protocol
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      allowed: false,
      error: `Protocol ${url.protocol} not allowed. Only HTTP and HTTPS are supported.`,
    };
  }

  // Block localhost and loopback
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(hostname)) {
    return {
      allowed: false,
      error: "Access to local resources is not permitted.",
    };
  }

  // Block private IP ranges
  // 10.0.0.0/8 (10.0.0.0 - 10.255.255.255)
  if (/^10\./.test(hostname)) {
    return {
      allowed: false,
      error: "Private IP range not allowed.",
    };
  }

  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) {
    return {
      allowed: false,
      error: "Private IP range not allowed.",
    };
  }

  // 192.168.0.0/16 (192.168.0.0 - 192.168.255.255)
  if (/^192\.168\./.test(hostname)) {
    return {
      allowed: false,
      error: "Private IP range not allowed.",
    };
  }

  // Block link-local addresses (169.254.0.0/16)
  if (/^169\.254\./.test(hostname)) {
    return {
      allowed: false,
      error: "Link-local addresses not allowed.",
    };
  }

  // Block IPv6 loopback and link-local
  if (/^(::1|fe80::|fc00::)/i.test(hostname)) {
    return {
      allowed: false,
      error: "IPv6 loopback and link-local addresses not allowed.",
    };
  }

  return { allowed: true };
}

/**
 * Fetch with timeout support
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param timeoutMs - Timeout in milliseconds (default: 10 seconds)
 * @returns Fetch response
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs: number = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timeout - server took too long to respond");
    }

    throw error;
  }
}
