import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'dikgang',
  description: 'Botswana Daily News archive reader, search, and chat'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
