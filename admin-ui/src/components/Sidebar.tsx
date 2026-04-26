'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    LayoutDashboard, MessageSquareText, ShieldAlert, Key, LogOut, FileText, ShieldCheck,
    ToggleRight, Play, ScanEye, BookOpen, UserCog, Building2, X, Bell,
    ScrollText, AlertTriangle, Settings, ClipboardCheck, ShieldEllipsis, BellRing, Sparkles,
    Scale, BadgeCheck, Terminal, Shield, Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/AuthProvider';
import { useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';

interface SidebarProps {
    mobileOpen?: boolean;
    onClose?: () => void;
}

// ── Shield badge: count critical+high open findings ───────────────────────
function useShieldBadge() {
    const { orgId } = useAuth();
    const [count, setCount] = useState(0);

    useEffect(() => {
        if (!orgId) return;
        const load = async () => {
            try {
                const res = await api.get(ENDPOINTS.SHIELD_FINDINGS, { params: { orgId } });
                const findings: { severity: string; status: string }[] = res.data.findings || [];
                setCount(findings.filter(f =>
                    ['critical', 'high'].includes(f.severity) && f.status === 'open'
                ).length);
            } catch {
                // silent — badge is non-critical UI
            }
        };
        load();
        const interval = setInterval(load, 60_000);
        return () => clearInterval(interval);
    }, [orgId]);

    return count;
}

// ── Exceptions badge: count expiring within 30 days ───────────────────────
function useExceptionsBadge() {
    const { orgId } = useAuth();
    const [count, setCount] = useState(0);

    useEffect(() => {
        if (!orgId) return;
        const load = async () => {
            try {
                const res = await api.get(ENDPOINTS.POLICY_EXCEPTIONS_EXPIRING);
                setCount((res.data as unknown[]).length);
            } catch {
                // silent
            }
        };
        load();
        const interval = setInterval(load, 60_000);
        return () => clearInterval(interval);
    }, [orgId]);

    return count;
}

// ── Nav item helper ────────────────────────────────────────────────────────
function NavItem({
    href, label, Icon, isActive, accentClass, iconActiveClass, badge, onClose,
}: {
    href: string;
    label: string;
    Icon: React.ElementType;
    isActive: boolean;
    accentClass: string;      // e.g. 'bg-amber-400'
    iconActiveClass: string;  // e.g. 'text-amber-400'
    badge?: number;
    onClose?: () => void;
}) {
    return (
        <Link
            href={href}
            onClick={onClose}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative overflow-hidden',
                isActive
                    ? 'bg-secondary/80 text-foreground ring-1 ring-border shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/30',
            )}
        >
            {isActive && (
                <div className={cn('absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r-full', accentClass)} />
            )}
            <Icon className={cn('w-4 h-4 transition-colors shrink-0', isActive ? iconActiveClass : 'group-hover:text-foreground')} />
            <span className="relative z-10 flex-1">{label}</span>
            {badge != null && badge > 0 && (
                <span className="bg-destructive text-destructive-foreground text-xs font-medium rounded-full min-w-[1.25rem] h-5 flex items-center justify-center px-1.5 shrink-0">
                    {badge > 99 ? '99+' : badge}
                </span>
            )}
        </Link>
    );
}

// ── Section label ──────────────────────────────────────────────────────────
function SectionLabel({ label }: { label: string }) {
    return (
        <div className="text-xs font-semibold text-muted-foreground/60 tracking-wider uppercase px-2 pt-4 pb-1.5">
            {label}
        </div>
    );
}

// ── Main sidebar content ───────────────────────────────────────────────────
function SidebarContent({ onClose }: { onClose?: () => void }) {
    const pathname = usePathname();
    const { logout, role, email } = useAuth();
    const badgeCount      = useShieldBadge();
    const exceptionsBadge = useExceptionsBadge();
    const t = useTranslations('nav');
    const tAuth = useTranslations('auth');
    const tShield = useTranslations('settings.shieldLevel');

    // Role groups
    const isGovernance = ['dpo', 'auditor', 'compliance'].includes(role ?? '');
    const isTechnical  = ['sre', 'operator'].includes(role ?? '');
    const isAdmin      = role === 'admin';
    const isPlatformAdmin = role === 'platform_admin';
    // Fallback: show everything if role is unknown/null
    const showAll = !isGovernance && !isTechnical && !isAdmin && !isPlatformAdmin;

    const showGovernance = isGovernance || isAdmin || isPlatformAdmin || showAll;
    const showTechnical  = isTechnical  || isAdmin || isPlatformAdmin || showAll;

    return (
        <div className="w-64 border-r border-border bg-card/60 backdrop-blur-md flex flex-col h-full shrink-0 shadow-[4px_0_24px_-10px_rgba(0,0,0,0.5)] z-20">
            {/* Logo */}
            <div className="h-16 flex items-center px-6 border-b border-border/50">
                <Link href="/" className="flex items-center gap-3 flex-1" onClick={onClose}>
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20 text-black flex items-center justify-center font-black text-lg">
                        G
                    </div>
                    <div className="flex flex-col">
                        <span className="font-bold text-lg leading-tight tracking-tight text-foreground">GovAI</span>
                        <span className="text-[10px] text-emerald-500 font-semibold tracking-widest uppercase">Platform</span>
                    </div>
                </Link>
                {onClose && (
                    <button onClick={onClose} className="lg:hidden p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            {/* Nav */}
            <div className="flex-1 py-4 px-3 flex flex-col overflow-y-auto">

                {/* GOVERNANÇA group */}
                {showGovernance && (
                    <>
                        {(isAdmin || showAll) && <SectionLabel label={t('governance')} />}
                        <NavItem href="/shield"     label={t('shield')}         Icon={ScanEye}       isActive={pathname === '/shield'}      accentClass="bg-amber-400" iconActiveClass="text-amber-400" badge={badgeCount}      onClose={onClose} />
                        <NavItem href="/catalog"    label={t('catalog')}        Icon={BookOpen}      isActive={pathname === '/catalog'}     accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        {/* FASE 14.0/5b.1 — superfície de execuções, irmã do Catálogo */}
                        <NavItem href="/execucoes"  label={t('execucoes')}      Icon={Activity}      isActive={pathname === '/execucoes' || pathname.startsWith('/execucoes/')} accentClass="bg-amber-400" iconActiveClass="text-amber-400" onClose={onClose} />
                        <NavItem href="/approvals"  label={t('approvals')}      Icon={ShieldCheck}   isActive={pathname === '/approvals'}   accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/reports"    label={t('reports')}        Icon={FileText}      isActive={pathname === '/reports'}     accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/compliance" label={t('compliance')}     Icon={ToggleRight}   isActive={pathname === '/compliance'}  accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/policies"   label={t('policies')}       Icon={ScrollText}    isActive={pathname === '/policies'}    accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/exceptions"       label={t('exceptions')}       Icon={AlertTriangle}   isActive={pathname === '/exceptions'}       accentClass="bg-amber-400" iconActiveClass="text-amber-400" badge={exceptionsBadge} onClose={onClose} />
                        <NavItem href="/compliance-hub"   label={t('complianceHub')}    Icon={ClipboardCheck}  isActive={pathname === '/compliance-hub'}   accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/bias"             label={t('bias')}             Icon={Scale}           isActive={pathname === '/bias'}             accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/skills"           label={t('skills')}           Icon={Sparkles}        isActive={pathname === '/skills'}           accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        <NavItem href="/logs"             label={t('auditLogs')}        Icon={ShieldAlert}     isActive={pathname === '/logs'}             accentClass="bg-amber-400" iconActiveClass="text-amber-400"                         onClose={onClose} />
                        {(isAdmin || role === 'dpo') && (
                            <NavItem href="/settings/dlp" label={t('dataProtection')} Icon={ShieldEllipsis} isActive={pathname === '/settings/dlp'} accentClass="bg-amber-400" iconActiveClass="text-amber-400" onClose={onClose} />
                        )}
                        {(isAdmin || role === 'dpo') && (
                            <NavItem href="/settings/icp-brasil" label={t('icpBrasil')} Icon={BadgeCheck} isActive={pathname === '/settings/icp-brasil'} accentClass="bg-amber-400" iconActiveClass="text-amber-400" onClose={onClose} />
                        )}
                    </>
                )}

                {/* TÉCNICO group */}
                {showTechnical && (
                    <>
                        {(isAdmin || showAll) && <SectionLabel label={t('technical')} />}
                        <NavItem href="/"           label={t('dashboard')}   Icon={LayoutDashboard}  isActive={pathname === '/'}           accentClass="bg-emerald-500" iconActiveClass="text-emerald-500" onClose={onClose} />
                        <NavItem href="/assistants" label={t('assistants')}  Icon={MessageSquareText} isActive={pathname === '/assistants'} accentClass="bg-emerald-500" iconActiveClass="text-emerald-500" onClose={onClose} />
                        <NavItem href="/playground" label={t('chat')}        Icon={MessageSquareText} isActive={pathname === '/playground'} accentClass="bg-emerald-500" iconActiveClass="text-emerald-500" onClose={onClose} />
                        <NavItem href="/api-keys"   label={t('apiKeys')}     Icon={Key}              isActive={pathname === '/api-keys'}   accentClass="bg-emerald-500" iconActiveClass="text-emerald-500" onClose={onClose} />
                        {/* FASE 14.0 Etapa 1: /architect menu entry removed along with the workflow domain. */}
                        <NavItem href="/webhooks"   label={t('webhooks')}    Icon={Bell}             isActive={pathname === '/webhooks'}   accentClass="bg-emerald-500" iconActiveClass="text-emerald-500" onClose={onClose} />
                    </>
                )}

                {/* Consultant (admin, sre, dpo — roles that had it before) */}
                {(isAdmin || isTechnical || isGovernance || showAll) && (
                    <NavItem href="/consultant" label={t('consultant')} Icon={UserCog} isActive={pathname === '/consultant'} accentClass="bg-emerald-500" iconActiveClass="text-emerald-500" onClose={onClose} />
                )}

                {/* Platform (admin + platform_admin) */}
                {(isAdmin || isPlatformAdmin || showAll) && (
                    <>
                        <SectionLabel label={t('platform')} />
                        <NavItem href="/organizations"          label={t('organizations')} Icon={Building2} isActive={pathname === '/organizations'}          accentClass="bg-indigo-400" iconActiveClass="text-indigo-400" onClose={onClose} />
                        <NavItem href="/settings"               label={t('settings')}      Icon={Settings}  isActive={pathname === '/settings'}               accentClass="bg-indigo-400" iconActiveClass="text-indigo-400" onClose={onClose} />
                        {isAdmin && (
                            <NavItem href="/settings/notifications" label={t('notifications')} Icon={BellRing}  isActive={pathname === '/settings/notifications'} accentClass="bg-indigo-400" iconActiveClass="text-indigo-400" onClose={onClose} />
                        )}
                        {(isAdmin || role === 'dpo') && (
                            <NavItem href="/settings/shield-level" label={tShield('navLabel')} Icon={Shield} isActive={pathname === '/settings/shield-level'} accentClass="bg-indigo-400" iconActiveClass="text-indigo-400" onClose={onClose} />
                        )}
                        <NavItem href="/developers" label={t('developers')} Icon={Terminal} isActive={pathname === '/developers'} accentClass="bg-indigo-400" iconActiveClass="text-indigo-400" onClose={onClose} />
                    </>
                )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-border/50 bg-background/30">
                <div className="flex items-center gap-3 px-3 py-3 mb-2 rounded-lg bg-secondary/30 border border-border/30">
                    <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-xs ring-1 ring-indigo-500/30 uppercase">
                        {email ? email.substring(0, 2) : 'AD'}
                    </div>
                    <div className="flex flex-col">
                        <span className="text-xs font-medium text-foreground capitalize">{role}</span>
                        <span className="text-[10px] text-muted-foreground max-w-[150px] truncate" title={email}>{email}</span>
                    </div>
                </div>
                <div className="mb-2">
                    <LocaleSwitcher />
                </div>
                <button
                    onClick={logout}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                    <LogOut className="w-4 h-4" />
                    {tAuth('logout')}
                </button>
            </div>
        </div>
    );
}

// ── Exported component ─────────────────────────────────────────────────────
export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
    return (
        <>
            {/* Desktop sidebar — always visible on lg+ */}
            <aside className="hidden lg:flex h-full shrink-0">
                <SidebarContent />
            </aside>

            {/* Mobile overlay */}
            {mobileOpen && (
                <aside className="fixed inset-0 z-50 lg:hidden flex">
                    <div
                        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
                        onClick={onClose}
                        aria-hidden="true"
                    />
                    <div className="relative z-10 h-full">
                        <SidebarContent onClose={onClose} />
                    </div>
                </aside>
            )}
        </>
    );
}
