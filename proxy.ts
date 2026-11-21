import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "@/lib/csp";

function createNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * Adds a per-request nonce and a strict Content Security Policy to document
 * responses. Next.js reads the nonce from the CSP header and applies it to the
 * framework and page scripts it renders. API routes are excluded by the
 * matcher below; they only serve JSON and event streams.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    realtimeEnabled: process.env.REALTIME_ENABLED === "true",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
