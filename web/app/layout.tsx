import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '../lib/session';
import './globals.css';

export const metadata: Metadata = { title: 'Payroll', description: 'Time tracking and payroll' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
