'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, MessageSquareText, ShieldAlert, Key, LogOut, FileText, ShieldCheck, ToggleRight, Play, ScanEye, BookOpen, UserCog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/AuthProvider';

export function Sidebar() {
    const pathname = usePathname();
    const { logout, role, email } = useAuth();

    const coreItems = [
        { label: 'Dashboard', href: '/', icon: LayoutDashboard, allowed: ['admin', 'sre', 'dpo', 'auditor', 'operator'] },
        { label: 'Playground', href: '/playground', icon: Play, allowed: ['admin', 'sre', 'operator'] },
        { label: 'Audit Logs', href: '/logs', icon: ShieldAlert, allowed: ['admin', 'sre', 'dpo', 'auditor', 'operator'] },
        { label: 'Assistants & RAG', href: '/assistants', icon: MessageSquareText, allowed: ['admin', 'sre', 'operator'] },
        { label: 'API Keys', href: '/api-keys', icon: Key, allowed: ['admin'] },
        { label: 'Approvals', href: '/approvals', icon: ShieldCheck, allowed: ['admin', 'sre', 'dpo'] },
        { label: 'Compliance LGPD', href: '/compliance', icon: ToggleRight, allowed: ['admin', 'dpo'] },
        { label: 'Reports', href: '/reports', icon: FileText, allowed: ['admin', 'dpo', 'auditor'] },
    ];

    const detectionItems = [
        { label: 'Shield Detection', href: '/shield', icon: ScanEye, allowed: ['admin', 'sre', 'dpo', 'auditor'] },
        { label: 'Catálogo de Agentes', href: '/catalog', icon: BookOpen, allowed: ['admin', 'operator', 'auditor'] },
        { label: 'Painel do Consultor', href: '/consultant', icon: UserCog, allowed: ['admin', 'sre', 'dpo'] },
    ];

    const visibleCoreItems = coreItems.filter(item => item.allowed.includes(role));
    const visibleDetectionItems = detectionItems.filter(item => item.allowed.includes(role));

    return (
        <aside className="w-64 border-r border-border bg-card/60 backdrop-blur-md flex flex-col h-full shrink-0 shadow-[4px_0_24px_-10px_rgba(0,0,0,0.5)] z-20">
            <div className="h-16 flex items-center px-6 border-b border-border/50">
                <Link href="/" className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20 text-black flex items-center justify-center font-black text-lg">
                        G
                    </div>
                    <div className="flex flex-col">
                        <span className="font-bold text-lg leading-tight tracking-tight text-foreground">GovAI</span>
                        <span className="text-[10px] text-emerald-500 font-semibold tracking-widest uppercase">Platform</span>
                    </div>
                </Link>
            </div>

            <div className="flex-1 py-6 px-4 flex flex-col gap-1.5 overflow-y-auto">
                <div className="text-xs font-semibold text-muted-foreground/60 tracking-wider uppercase mb-2 px-2">
                    Core Modules
                </div>
                {visibleCoreItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative overflow-hidden",
                                isActive
                                    ? "bg-secondary/80 text-foreground ring-1 ring-border shadow-sm"
                                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
                            )}
                        >
                            {isActive && (
                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-emerald-500 rounded-r-full" />
                            )}
                            <item.icon className={cn("w-4 h-4 transition-colors", isActive ? "text-emerald-500" : "group-hover:text-foreground")} />
                            <span className="relative z-10">{item.label}</span>
                        </Link>
                    )
                })}

                {visibleDetectionItems.length > 0 && (
                    <>
                        <div className="text-xs font-semibold text-muted-foreground/60 tracking-wider uppercase mt-4 mb-2 px-2">
                            Detection &amp; Registry
                        </div>
                        {visibleDetectionItems.map((item) => {
                            const isActive = pathname === item.href;
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative overflow-hidden",
                                        isActive
                                            ? "bg-secondary/80 text-foreground ring-1 ring-border shadow-sm"
                                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
                                    )}
                                >
                                    {isActive && (
                                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-amber-400 rounded-r-full" />
                                    )}
                                    <item.icon className={cn("w-4 h-4 transition-colors", isActive ? "text-amber-400" : "group-hover:text-foreground")} />
                                    <span className="relative z-10">{item.label}</span>
                                </Link>
                            )
                        })}
                    </>
                )}
            </div>

            <div className="p-4 border-t border-border/50 bg-background/30">
                {/* Admin user preview */}
                <div className="flex items-center gap-3 px-3 py-3 mb-2 rounded-lg bg-secondary/30 border border-border/30">
                    <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-xs ring-1 ring-indigo-500/30 uppercase">
                        {email ? email.substring(0, 2) : 'AD'}
                    </div>
                    <div className="flex flex-col">
                        <span className="text-xs font-medium text-foreground capitalize">{role}</span>
                        <span className="text-[10px] text-muted-foreground max-w-[150px] truncate" title={email}>{email}</span>
                    </div>
                </div>

                <button
                    onClick={logout}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                    <LogOut className="w-4 h-4" />
                    Encerrar Sessão
                </button>
            </div>
        </aside>
    );
}
