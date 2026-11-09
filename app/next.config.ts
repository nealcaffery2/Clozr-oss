import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // CLOZR renders entirely on the client — the shell, every screen and the
  // Supabase-backed lists all run in the browser — so the app ships as a static
  // export. That makes it hostable on any static CDN (Vercel, Cloudflare Pages)
  // without a server runtime.
  output: 'export',
  // The operator app's address is a path (/app/people/s42, lib/routes.ts) on
  // one page. `vinext dev` and `vinext start` serve that page for every path
  // under it with these; the static export ignores them, so vercel.json
  // carries the same two rewrites for production (tools/routes-hosting.test.ts
  // keeps the lists equal).
  async rewrites() {
    return [
      { source: '/app/:path+', destination: '/app' },
      { source: '/demo/:path+', destination: '/demo' },
    ];
  },
};

export default nextConfig;
