import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lunik Write',
  description: 'An AI-powered writing assistant that checks grammar, spelling, and clarity as you write.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
