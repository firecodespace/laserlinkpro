import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '../components/Nav';

export const metadata: Metadata = {
  title: 'LaserLink Console',
  description: 'IoT laser communication link - transmitter console and camera receiver',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0e13',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
