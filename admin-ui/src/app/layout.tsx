import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GovAI Platform',
  description: 'Enterprise AI Governance Gateway',
};

import { AuthProvider } from '@/components/AuthProvider';
import { LayoutWrapper } from '@/components/LayoutWrapper';
import { ToastProvider } from '@/components/Toast';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="font-sans bg-background text-foreground h-screen flex overflow-hidden">
        <AuthProvider>
          <ToastProvider>
            <LayoutWrapper>
              {children}
            </LayoutWrapper>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
