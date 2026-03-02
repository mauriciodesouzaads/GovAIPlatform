'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, MessageSquareText, ShieldAlert, Key, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/AuthProvider';

export function Sidebar() {
    const pathname = usePathname();
    const { logout } = useAuth();

    const navItems = [
        { label: 'Dashboard', href: '/', icon: LayoutDashboard },
        { label: 'Audit Logs', href: '/logs', icon: ShieldAlert },
        { label: 'Assistants & RAG', href: '/assistants', icon: MessageSquareText },
        { label: 'API Keys', href: '/api-keys', icon: Key },
    ];

    return (
        <aside className="w-64 border-r border-border bg-card flex flex-col h-full shrink-0">
            <div className="h-16 flex items-center px-6 border-b border-border">
                <h1 className="font-bold text-xl tracking-tight flex items-center gap-2">
                    <div className="w-6 h-6 rounded-md bg-white text-black flex items-center justify-center font-black text-sm">G</div>
                    GovAI <span className="text-muted-foreground font-medium text-sm">Platform</span>
                </h1>
            </div>

            <div className="flex-1 py-6 px-4 flex flex-col gap-1">
                {navItems.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                            "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                            pathname === item.href
                                ? "bg-secondary text-foreground"
                                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                        )}
                    >
                        <item.icon className="w-4 h-4" />
                        {item.label}
                    </Link>
                ))}
            </div>

            <div className="p-4 border-t border-border">
                <button
                    onClick={logout}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                    <LogOut className="w-4 h-4" />
                    Sair
                </button>
            </div>
        </aside>
    );
}
