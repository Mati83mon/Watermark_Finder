'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/analysis/', label: 'New analysis' },
  { href: '/reports/', label: 'Reports' },
  { href: '/settings/', label: 'Settings' },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1 text-sm">
      {LINKS.map((link) => {
        const active =
          link.href === '/' ? pathname === '/' : pathname.startsWith(link.href.replace(/\/$/, ''));
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-2.5 py-1.5 transition-colors ${
              active ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface hover:text-ink'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
