export interface ContentSecurityPolicyOptions {
  nonce: string;
  isDev: boolean;
  realtimeEnabled: boolean;
}

/**
 * Single source of truth for the document CSP. The OpenAI origin is allowed
 * only when the optional Realtime/WebRTC transport is enabled, so the default
 * deployment keeps the narrowest possible connect surface.
 */
export function buildContentSecurityPolicy({
  nonce,
  isDev,
  realtimeEnabled,
}: ContentSecurityPolicyOptions): string {
  const connectSources = [
    "'self'",
    ...(realtimeEnabled ? ["https://api.openai.com", "wss://api.openai.com"] : []),
  ];

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
