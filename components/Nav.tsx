'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Overview' },
  { href: '/transmit/', label: 'Transmit' },
  { href: '/receive/', label: 'Receive' },
  { href: '/protocol/', label: 'Protocol' },
];

export function Nav() {
  const path = usePathname() || '/';
  const norm = path.endsWith('/') ? path : path + '/';
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-dot" />
          <span>
            LaserLink
            <small>Phase-0 optical link</small>
          </span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} data-active={norm === t.href}>
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
