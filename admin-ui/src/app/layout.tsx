import type { Metadata } from 'next';
import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { AuthProvider } from '@/components/AuthProvider';
import { LayoutWrapper } from '@/components/LayoutWrapper';
import { ToastProvider } from '@/components/Toast';

export const metadata: Metadata = {
  title: 'GovAI Platform',
  description: 'Enterprise AI Governance Gateway',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // next-intl resolves locale via src/i18n/request.ts (cookie → Accept-Language → default).
  // We mirror it onto <html lang="..."> so screen readers + translation
  // widgets pick up the right language.
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className="dark">
      <body className="font-sans bg-background text-foreground h-screen flex overflow-hidden">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AuthProvider>
            <ToastProvider>
              <LayoutWrapper>
                {children}
              </LayoutWrapper>
            </ToastProvider>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
