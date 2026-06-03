import type { NextConfig } from "next";

// Cloudflare deploys this app through @opennextjs/cloudflare, so production
// builds keep the normal Next.js runtime instead of static-exporting to ./out.
const nextConfig: NextConfig = {};

export default nextConfig;
