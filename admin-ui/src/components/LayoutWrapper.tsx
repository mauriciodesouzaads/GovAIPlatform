'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isLoginPage = pathname === '/login';
    const isChatPage = pathname.startsWith('/chat');

    if (isChatPage) {
        return <>{children}</>;
    }

    return (
        <>
            {!isLoginPage && <Sidebar />}
            <main className="flex-1 flex flex-col h-full overflow-hidden relative">
                {children}
            </main>
        </>
    );
}
