import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'GovAI Platform',
  description: 'Enterprise AI Governance Gateway',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background text-foreground h-screen flex overflow-hidden`}>
        <Sidebar />
        <main className="flex-1 flex flex-col h-full overflow-hidden">
          {children}
        </main>
      </body>
    </html>
  );
}
