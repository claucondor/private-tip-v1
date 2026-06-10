import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @claucondor/sdk server-side packages: don't bundle for SSR, require at runtime.
  serverExternalPackages: [
    "@openjanus/sdk",
    "@claucondor/sdk",
    "snarkjs",
    "circomlibjs",
    "ffjavascript",
  ],
  // Force Vercel to ship the SDK circuit artifacts (wasm + zkey) alongside
  // the proof API routes. Marking the SDK as external skips tracing of its
  // data files; without this, /api/proof/* throws ENOENT at runtime.
  outputFileTracingIncludes: {
    "/api/proof/**": [
      "./node_modules/@claucondor/sdk/circuits/**",
    ],
  },
  // Turbopack config (Next.js 16 — used by `next build` and `next dev`).
  // @claucondor/sdk/dist/crypto/index.js uses `await import('fs')` inside
  // server-only async helpers. These code paths never run in the browser, but
  // Turbopack still resolves the import statically.
  // Use { browser: ... } syntax so the shim applies ONLY to browser bundles;
  // server bundles (API routes, RSC) still get the real Node.js 'fs' module.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./shims/node-empty.js" },
    },
  },
};

export default nextConfig;
