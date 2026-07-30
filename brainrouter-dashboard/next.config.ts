import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cloudflare deploys this app through @opennextjs/cloudflare, so production
// builds keep the normal Next.js runtime instead of static-exporting to ./out.
const nextConfig: NextConfig = {
  // This dashboard is one package inside the BrainRouter workspace. Pin file
  // tracing to the repository root so an unrelated lockfile in $HOME cannot
  // make Next scan/package the user's entire home directory.
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
};

export default nextConfig;
