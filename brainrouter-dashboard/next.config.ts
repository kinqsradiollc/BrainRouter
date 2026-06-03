import type { NextConfig } from "next";

// The dashboard is a fully client-rendered app (no API routes, server
// components, or server actions — all data comes from the BrainRouter HTTP API
// via the SDK), so it exports cleanly to static HTML for Cloudflare Workers
// Static Assets. The static-export config is gated behind CLOUDFLARE_BUILD so
// the default `next build` / `next start` (server build) is unchanged for local
// dev and any non-Cloudflare target. See DEPLOY-CLOUDFLARE.md.
const cloudflareStatic = process.env.CLOUDFLARE_BUILD === "1";

const nextConfig: NextConfig = cloudflareStatic
  ? {
      output: "export", // → ./out (static HTML + assets), served by a Worker
      images: { unoptimized: true }, // no Image Optimization server on static hosting
    }
  : {};

export default nextConfig;
