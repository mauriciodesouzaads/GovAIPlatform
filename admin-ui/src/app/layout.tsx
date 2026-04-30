import type { Metadata } from 'next';
import { Inter, DM_Serif_Display, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { AuthProvider } from '@/components/AuthProvider';
import { LayoutWrapper } from '@/components/LayoutWrapper';
import { ToastProvider } from '@/components/Toast';
import { ThemeProvider, NO_FOUC_SCRIPT } from '@/lib/theme';

// FASE 14.0/6c.B.3 CP1 — fontes Google via next/font.
// Inter — sans (UI/body), DM Serif Display — serif (títulos primários
// estilo Claude.ai), JetBrains Mono — mono (code blocks, IDs, hashes).
// Cada font expõe uma CSS var (ex.: --font-inter) que é referenciada
// no @theme do globals.css em --font-sans/serif/mono.
const fontSans = Inter({
    subsets: ['latin'],
    variable: '--font-inter',
    display: 'swap',
});

const fontSerif = DM_Serif_Display({
    weight: ['400'],
    subsets: ['latin'],
    variable: '--font-dm-serif',
    display: 'swap',
});

const fontMono = JetBrains_Mono({
    subsets: ['latin'],
    variable: '--font-jetbrains-mono',
    display: 'swap',
});

export const metadata: Metadata = {
  title: 'GovAI Platform',
  description: 'Enterprise AI Governance Gateway',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    // 6c.B.3 CP1 — suppressHydrationWarning permite o NO_FOUC_SCRIPT
    // mutar a className antes do React hydratar sem warning. As CSS
    // vars das fontes ficam disponíveis globalmente; o @theme no
    // globals.css resolve --font-sans/serif/mono via essas vars.
    //
    // <html className> não fixa mais "dark" — o ThemeProvider +
    // NO_FOUC_SCRIPT controlam a classe dinamicamente baseada em
    // localStorage('govai-theme') + prefers-color-scheme.
    <html
      lang={locale}
      className={`${fontSans.variable} ${fontSerif.variable} ${fontMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Anti-FOUC: aplica .dark/.light className antes da primeira
            pintura do React, lendo localStorage + matchMedia. Evita
            flash de tema claro→escuro ao reload. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FOUC_SCRIPT }} />
      </head>
      <body className="font-sans bg-background text-foreground h-screen flex overflow-hidden">
        <ThemeProvider>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <AuthProvider>
              <ToastProvider>
                <LayoutWrapper>
                  {children}
                </LayoutWrapper>
              </ToastProvider>
            </AuthProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
