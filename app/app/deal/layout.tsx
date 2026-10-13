import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Deal · Acme Homes',
  // A tracked link is one buyer's; it is not a page to index.
  robots: { index: false, follow: false },
};

export default function DealLayout({ children }: { children: React.ReactNode }) {
  return children;
}
