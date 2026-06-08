import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @openjanus/sdk@0.4.4+ is browser-safe (lazy Node imports). Crypto helpers
  // are also called server-side via /api/memo/* + /api/note/* routes to keep
  // the client bundle light.
  serverExternalPackages: [
    "@openjanus/sdk",
    "@claucondor/sdk",
    "snarkjs",
    "circomlibjs",
    "ffjavascript",
  ],
};

export default nextConfig;
