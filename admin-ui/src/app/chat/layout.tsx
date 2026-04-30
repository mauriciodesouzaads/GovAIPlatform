'use client';

import { ChatSidebar } from './_components/ChatSidebar';
import { Toaster } from 'sonner';

/**
 * /chat layout — full-screen, sidebar-only nav.
 *
 * The chat product has its own visual language (Claude Desktop-like)
 * so we suppress the global LayoutWrapper / Sidebar by occupying the
 * full viewport. Anyone navigating away (e.g. via ⌘+K to /execucoes)
 * gets the global shell back; this layout only applies under /chat/*.
 *
 * Palette is set per ADR (TBD) — #0C0F14 backdrop, #141820 panels,
 * #10B981 accents. No assumption about light mode (this surface is
 * dark-only on purpose — matches Claude.ai's design language and
 * reduces visual context-switching when users are coding side-by-side
 * with the chat).
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 bg-[#0C0F14] text-text-100 flex font-sans antialiased">
            <aside className="hidden md:flex w-72 flex-shrink-0 border-r border-border-100 bg-[#0a0d12] flex-col">
                <ChatSidebar />
            </aside>
            <main className="flex-1 flex flex-col min-w-0">{children}</main>
            <Toaster
                position="bottom-right"
                theme="dark"
                richColors
                toastOptions={{
                    classNames: {
                        toast: 'bg-[#141820] border border-border-200 text-text-100',
                    },
                }}
            />
        </div>
    );
}
