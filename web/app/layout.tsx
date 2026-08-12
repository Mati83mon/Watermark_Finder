import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { EngineStatus } from '@/components/EngineStatus';
import { NavLinks } from '@/components/NavLinks';

export const metadata: Metadata = {
  title: 'Watermark Finder',
  description:
    'Detect hidden watermarks and analyse text provenance. Deterministic covert-channel detection plus stylometry, running entirely on free infrastructure.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="no-print border-b border-border bg-elevated">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="text-lg">
                🔍
              </span>
              Watermark Finder
            </Link>
            <NavLinks />
            <div className="ml-auto">
              <EngineStatus />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>

        <footer className="no-print mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
          <p>
            Stylometric scores describe writing register, not authorship. They are unreliable on
            short or translated text and must not be the sole basis for an accusation, a grade or a
            disciplinary decision.
          </p>
        </footer>
      </body>
    </html>
  );
}
