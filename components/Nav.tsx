'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Nav() {
  const path = usePathname() || '/';
  const atRoot = path === '/' || path === '';
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link
          href="/"
          className="brand"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <span className="brand-dot" />
          <span>
            LaserLink
            <small>optical link</small>
          </span>
        </Link>
        <span className="spacer" />
        {!atRoot && (
          <Link className="linkBtn" href="/">
            Switch role
          </Link>
        )}
      </div>
    </header>
  );
}
