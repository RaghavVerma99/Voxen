const isProduction = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // The Redis client uses Node sockets; let Node load it natively in the
  // standalone server instead of bundling it into each route.
  serverExternalPackages: ["redis"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "microphone=(self), camera=(), geolocation=(), payment=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          // HSTS only makes sense on HTTPS deployments; browsers ignore it
          // over plain HTTP, so development is unaffected either way.
          ...(isProduction
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
