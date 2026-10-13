import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Inter } from 'next/font/google';
import { SessionProvider } from '@/lib/session';
import { ConfirmProvider } from '@/components/ds/Confirm';
import { CHUNK_RELOAD_SCRIPT } from '@/lib/chunk-reload';

// SF (San Francisco) is Apple-only and not licensed for the web, so the stack
// in tokens.css asks for it by name first — real SF on Mac/iPhone — and falls
// back to Inter, the closest free look-alike, everywhere else.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'CLOZR — The operating system for your acquisitions',
  description: 'Lead, property, underwriting, communications, buyers, disposition and closing — one CRM, one dataset, one interface.',
  openGraph: {
    title: 'Clozr — One workspace. Every deal moving.',
    description: 'The focused CRM command center for acquisitions, dispositions, transactions, deals, and partnerships.',
    images: [{ url: '/og.png', width: 1732, height: 903, alt: 'Clozr — One workspace. Every deal moving.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Clozr — One workspace. Every deal moving.',
    description: 'The focused CRM command center for acquisitions, dispositions, transactions, deals, and partnerships.',
    images: ['/og.png'],
  },
  // Add to Home Screen: CLOZR opens as its own app, with no Safari bars and
  // the page drawn under a black-translucent status bar (globals.css paints
  // the strip behind it). A static file, since the app is a static export.
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'CLOZR', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  other: { 'apple-mobile-web-app-capable': 'yes', 'mobile-web-app-capable': 'yes' },
};

// Mobile needs a real viewport or the browser lays the app out at 980px and
// zooms out. `viewportFit: 'cover'` lets the bottom tab bar sit under the home
// indicator using env(safe-area-inset-*).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // One session for the whole app: the landing page, the login screens, the
  // route guard and the shell's account menu all read the same provider.
  return (
    <html lang="en" className={inter.variable}>
      <head>
        {/* Inline and first, so a tab older than the live deploy reloads onto
            the new chunks instead of failing its first lazy import. */}
        <script dangerouslySetInnerHTML={{ __html: CHUNK_RELOAD_SCRIPT }} />
      </head>
      <body>
        <SessionProvider><ConfirmProvider>{children}</ConfirmProvider></SessionProvider>
      </body>
    </html>
  );
}
