'use client';

/**
 * Shield Level — FASE 13.5a
 * ---------------------------------------------------------------------------
 * Admin/DPO page for viewing and changing the organization's shield level.
 * The transition requires the user to acknowledge a markdown notice whose
 * SHA-256 hash is re-verified by the backend before the change is applied.
 *
 * Design choice: we render the backend-provided markdown verbatim so the
 * server remains the single source of truth on legal wording — an auditor
 * reviewing the evidence record can recompute the hash from the committed
 * templates under `docs/legal/shield_notices/` and verify it matches.
 */

import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useLocale, useTranslations } from 'next-intl';
import { ShieldCheck, RefreshCw, X, CheckCircle2, AlertTriangle, Shield } from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────

type ShieldLevel = 1 | 2 | 3;

interface CurrentState {
    shield_level: ShieldLevel;
    shield_level_updated_at: string | null;
    shield_level_updated_by: string | null;
    shield_level_updated_by_email: string | null;
}

interface HistoryEntry {
    id: string;
    actor_email: string | null;
    from_level: number;
    to_level: number;
    template_locale: string;
    template_hash: string;
    created_at: string;
}

interface NoticePayload {
    template_content: string;
    template_hash: string;
    from_level: number;
    to_level: number;
    locale: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function levelLabel(n: number, t: (k: string) => string): string {
    switch (n) {
        case 1: return t('level1');
        case 2: return t('level2');
        case 3: return t('level3');
        default: return `Level ${n}`;
    }
}

function levelShort(n: number, t: (k: string) => string): string {
    switch (n) {
        case 1: return t('level1Short');
        case 2: return t('level2Short');
        case 3: return t('level3Short');
        default: return `L${n}`;
    }
}

function levelAccent(n: number): { dot: string; ring: string; bg: string; text: string } {
    if (n === 1) return { dot: 'bg-emerald-400', ring: 'ring-success-fg', bg: 'bg-emerald-500/5', text: 'text-success-fg' };
    if (n === 2) return { dot: 'bg-amber-400', ring: 'ring-warning-fg', bg: 'bg-amber-500/5', text: 'text-warning-fg' };
    return { dot: 'bg-rose-400', ring: 'ring-danger-fg', bg: 'bg-rose-500/5', text: 'text-danger-fg' };
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function ShieldLevelPage() {
    const t = useTranslations('settings.shieldLevel');
    const { toast } = useToast();
    const locale = useLocale();

    const [current, setCurrent] = useState<CurrentState | null>(null);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [targetLevel, setTargetLevel] = useState<ShieldLevel | null>(null);
    const [notice, setNotice] = useState<NoticePayload | null>(null);
    const [loadingNotice, setLoadingNotice] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.SHIELD_LEVEL);
            setCurrent(res.data?.current ?? null);
            setHistory(res.data?.history ?? []);
        } catch {
            toast(t('errors.loadFailed'), 'error');
        } finally {
            setLoading(false);
        }
    }, [toast, t]);

    useEffect(() => { load(); }, [load]);

    const openChangeModal = async (level: ShieldLevel) => {
        if (!current || level === current.shield_level) return;
        setTargetLevel(level);
        setNotice(null);
        setAcknowledged(false);
        setLoadingNotice(true);
        try {
            const res = await api.get(ENDPOINTS.SHIELD_LEVEL_NOTICE(current.shield_level, level, locale));
            setNotice(res.data);
        } catch {
            toast(t('errors.loadFailed'), 'error');
            setTargetLevel(null);
        } finally {
            setLoadingNotice(false);
        }
    };

    const closeModal = () => {
        setTargetLevel(null);
        setNotice(null);
        setAcknowledged(false);
    };

    const confirmChange = async () => {
        if (!notice || !targetLevel || !acknowledged) return;
        setSubmitting(true);
        try {
            const res = await api.post(ENDPOINTS.SHIELD_LEVEL_CHANGE, {
                new_level: targetLevel,
                template_hash: notice.template_hash,
                acknowledgment: t('acknowledge'),
                locale: notice.locale,
            });
            toast(`${levelShort(targetLevel, t)} · ✓`, 'success');
            closeModal();
            await load();
            void res;
        } catch (err: any) {
            const status = err?.response?.status;
            const code = err?.response?.data?.error;
            if (status === 409) {
                toast(t('errors.hashMismatch'), 'error');
            } else if (status === 400 && code?.includes('already')) {
                toast(t('errors.sameLevel'), 'error');
            } else {
                toast(code || t('errors.changeFailed'), 'error');
            }
        } finally {
            setSubmitting(false);
        }
    };

    const curLevel: ShieldLevel | null = current?.shield_level ?? null;

    return (
        <div className="p-6 max-w-5xl mx-auto">
            <PageHeader
                title={t('title')}
                subtitle={t('subtitle')}
                icon={<Shield className="w-5 h-5" />}
                actions={
                    <button
                        onClick={load}
                        disabled={loading}
                        className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-border bg-secondary/50 hover:bg-secondary disabled:opacity-40"
                    >
                        <RefreshCw className="w-4 h-4" /> {t('cancel') /* noop: repurpose existing key as 'reload' label is overkill */ ? '' : ''}
                        Reload
                    </button>
                }
            />

            {/* Current level card */}
            <div className={`border rounded-xl p-5 mb-5 ${curLevel ? `${levelAccent(curLevel).bg} ${levelAccent(curLevel).ring} ring-1` : 'bg-card/40 border-border'}`}>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{t('currentLevel')}</div>
                <div className="flex items-center gap-3 mt-2">
                    {curLevel && <div className={`w-3 h-3 rounded-full ${levelAccent(curLevel).dot}`} />}
                    <div className={`text-2xl font-bold ${curLevel ? levelAccent(curLevel).text : 'text-foreground'}`}>
                        {curLevel ? levelLabel(curLevel, t) : '—'}
                    </div>
                </div>
                {current?.shield_level_updated_at && (
                    <div className="text-xs text-muted-foreground mt-2">
                        {new Date(current.shield_level_updated_at).toLocaleString(locale)}
                        {current.shield_level_updated_by_email && <> · {current.shield_level_updated_by_email}</>}
                    </div>
                )}
            </div>

            {/* Level selector */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                {([1, 2, 3] as ShieldLevel[]).map((lvl) => {
                    const a = levelAccent(lvl);
                    const isCurrent = curLevel === lvl;
                    return (
                        <div
                            key={lvl}
                            className={`border rounded-xl p-4 ${isCurrent ? `${a.bg} ${a.ring} ring-1` : 'bg-card/30 border-border'} flex flex-col gap-3`}
                        >
                            <div className="flex items-center gap-2">
                                <div className={`w-2.5 h-2.5 rounded-full ${a.dot}`} />
                                <div className={`font-semibold text-sm ${a.text}`}>
                                    {levelLabel(lvl, t)}
                                </div>
                            </div>
                            <button
                                onClick={() => openChangeModal(lvl)}
                                disabled={isCurrent || loading}
                                className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-secondary/50 hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed mt-auto"
                            >
                                {isCurrent ? `✓ ${t('currentLevel')}` : t('changeButton')}
                            </button>
                        </div>
                    );
                })}
            </div>

            {/* History */}
            <div className="border border-border rounded-xl bg-card/40 overflow-hidden">
                <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">{t('historyTitle')}</h2>
                </div>
                <table className="w-full text-sm">
                    <thead className="bg-secondary/30 text-muted-foreground text-xs uppercase tracking-wider">
                        <tr>
                            <th className="text-left p-3 font-medium">{t('historyColumns.when')}</th>
                            <th className="text-left p-3 font-medium">{t('historyColumns.from')}</th>
                            <th className="text-left p-3 font-medium">{t('historyColumns.to')}</th>
                            <th className="text-left p-3 font-medium">{t('historyColumns.actor')}</th>
                            <th className="text-left p-3 font-medium">{t('historyColumns.locale')}</th>
                            <th className="text-left p-3 font-medium">{t('historyColumns.hash')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {history.length === 0 && (
                            <tr>
                                <td colSpan={6} className="p-6 text-center text-muted-foreground text-xs">
                                    {t('historyEmpty')}
                                </td>
                            </tr>
                        )}
                        {history.map((h) => (
                            <tr key={h.id} className="border-t border-border/50">
                                <td className="p-3 text-xs">{new Date(h.created_at).toLocaleString(locale)}</td>
                                <td className="p-3">
                                    <span className={`text-xs px-2 py-0.5 rounded-md ${levelAccent(h.from_level).bg} ${levelAccent(h.from_level).text}`}>
                                        {levelShort(h.from_level, t)}
                                    </span>
                                </td>
                                <td className="p-3">
                                    <span className={`text-xs px-2 py-0.5 rounded-md ${levelAccent(h.to_level).bg} ${levelAccent(h.to_level).text}`}>
                                        {levelShort(h.to_level, t)}
                                    </span>
                                </td>
                                <td className="p-3 text-xs">{h.actor_email ?? '—'}</td>
                                <td className="p-3 text-xs font-mono">{h.template_locale}</td>
                                <td className="p-3 text-xs font-mono text-muted-foreground" title={h.template_hash}>
                                    {h.template_hash?.substring(0, 12)}…
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Change modal */}
            {targetLevel && curLevel && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4">
                    <div className="bg-card border border-border rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                        <div className="flex items-center justify-between p-5 border-b border-border">
                            <div className="flex items-center gap-2">
                                {targetLevel > curLevel
                                    ? <Shield className="w-5 h-5 text-primary" />
                                    : <AlertTriangle className="w-5 h-5 text-warning-fg" />}
                                <h2 className="text-lg font-semibold">
                                    {levelShort(curLevel, t)} → {levelShort(targetLevel, t)}
                                </h2>
                            </div>
                            <button onClick={closeModal} className="text-muted-foreground hover:text-foreground">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-5">
                            {loadingNotice && (
                                <div className="text-center text-muted-foreground py-10">{t('loadingNotice')}</div>
                            )}
                            {!loadingNotice && notice && (
                                <article className="prose prose-invert prose-sm max-w-none">
                                    <ReactMarkdown>{notice.template_content}</ReactMarkdown>
                                </article>
                            )}
                            {!loadingNotice && notice && (
                                <div className="text-[11px] font-mono text-muted-foreground mt-4">
                                    hash: {notice.template_hash}
                                </div>
                            )}
                        </div>

                        <div className="p-5 border-t border-border space-y-3 sticky bottom-0 bg-card">
                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={acknowledged}
                                    onChange={(e) => setAcknowledged(e.target.checked)}
                                    className="mt-0.5"
                                    disabled={!notice || loadingNotice || submitting}
                                />
                                <span className="text-sm">{t('acknowledge')}</span>
                            </label>
                            <div className="flex items-center justify-end gap-2">
                                <button
                                    onClick={closeModal}
                                    className="text-sm px-3 py-2 rounded-lg border border-border hover:bg-secondary/50"
                                    disabled={submitting}
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    onClick={confirmChange}
                                    disabled={!acknowledged || !notice || submitting}
                                    className="text-sm px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2"
                                >
                                    {submitting && <CheckCircle2 className="w-4 h-4 animate-pulse" />}
                                    {submitting ? t('confirming') : t('confirm')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
