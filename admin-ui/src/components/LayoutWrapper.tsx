'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isLoginPage = pathname === '/login';
    const isChatPage = pathname.startsWith('/chat');
    const [sidebarOpen, setSidebarOpen] = useState(false);

    if (isChatPage) {
        return <>{children}</>;
    }

    return (
        <>
            {!isLoginPage && (
                <Sidebar
                    mobileOpen={sidebarOpen}
                    onClose={() => setSidebarOpen(false)}
                />
            )}
            <main className="flex-1 flex flex-col h-full overflow-hidden relative">
                {/* Hamburger button — mobile only */}
                {!isLoginPage && (
                    <button
                        className="lg:hidden fixed top-4 left-4 z-40 p-2 bg-card border border-border rounded-lg text-muted-foreground hover:text-foreground transition-colors shadow-sm"
                        onClick={() => setSidebarOpen(true)}
                        aria-label="Abrir menu"
                        aria-expanded={sidebarOpen}
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                )}
                {children}
            </main>
        </>
    );
}
