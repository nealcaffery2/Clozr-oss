import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Off-market deals · Acme Homes',
  description: 'Investment properties from Acme Homes. Join the buyers list for matching off-market deals, COMPR numbers, and photos.',
  robots: { index: true, follow: true },
};

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
