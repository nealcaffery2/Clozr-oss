import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // CLOZR renders entirely on the client — the shell, every screen and the
  // Supabase-backed lists all run in the browser — so the app ships as a static
  // export. That makes it hostable on any static CDN (Vercel, Cloudflare Pages)
  // without a server runtime.
  output: 'export',
};

export default nextConfig;
