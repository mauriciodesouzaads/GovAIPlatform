'use client';

import { useCallback, useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import {
    Settings, Plus, X, Loader2, Save, Check, AlertTriangle,
    ChevronUp, ChevronDown, Trash2, Edit2, ToggleLeft, ToggleRight, Bell,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface OrgSettings {
    id: string;
    name: string;
    hitl_timeout_hours: number;
}

interface ReviewTrack {
    id: string;
    name: string;
    slug: string;
    description?: string;
    sla_hours: number;
    is_required: boolean;
    is_active: boolean;
    sort_order: number;
    created_at: string;
    updated_at?: string;
}

interface RetentionConfig {
    audit_log_retention_days: number;
    archive_enabled: boolean;
    last_archive_run_at?: string | null;
    last_archive_count?: number;
}

interface AlertThresholds {
    latency_p95_ms: number;
    violation_rate_pct: number;
    daily_cost_usd: number;
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <div className="bg-card border border-border rounded-xl p-6 mb-6">
            <div className="flex items-center justify-between border-b border-border pb-3 mb-5">
                <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                {action}
            </div>
            {children}
        </div>
    );
}

// ── Toggle switch ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !disabled && onChange(!checked)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-40 ${
                checked ? 'bg-primary' : 'bg-muted'
            }`}
        >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-background rounded-full shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
    );
}

// ── Toast ──────────────────────────────────────────────────────────────────

function useToast() {
    const [msg, setMsg] = useState('');
    const [variant, setVariant] = useState<'success' | 'error'>('success');
    const toast = (message: string, v: 'success' | 'error' = 'success') => {
        setMsg(message); setVariant(v);
        setTimeout(() => setMsg(''), 3500);
    };
    return { toast, toastEl: msg ? (
        <div className={`fixed top-6 right-6 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-medium animate-in slide-in-from-top-2 duration-300 ${
            variant === 'success' ? 'bg-emerald-600 text-white' : 'bg-destructive text-destructive-foreground'
        }`}>
            {variant === 'success' ? <Check className="w-4 h-4 inline mr-2" /> : <AlertTriangle className="w-4 h-4 inline mr-2" />}
            {msg}
        </div>
    ) : null };
}

// ── Track Modal ────────────────────────────────────────────────────────────

interface TrackForm { name: string; description: string; sla_hours: number; is_required: boolean; }

function TrackModal({ initial, onClose, onSaved }: {
    initial?: ReviewTrack;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [form, setForm] = useState<TrackForm>({
        name: initial?.name ?? '',
        description: initial?.description ?? '',
        sla_hours: initial?.sla_hours ?? 72,
        is_required: initial?.is_required ?? true,
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const isEdit = !!initial;

    const submit = async () => {
        if (form.name.trim().length < 2) { setError('Nome deve ter pelo menos 2 caracteres.'); return; }
        if (form.sla_hours < 1 || form.sla_hours > 720) { setError('SLA deve ser entre 1 e 720 horas.'); return; }
        setSaving(true); setError('');
        try {
            if (isEdit) {
                await api.put(ENDPOINTS.SETTINGS_REVIEW_TRACK(initial!.id), form);
            } else {
                await api.post(ENDPOINTS.SETTINGS_REVIEW_TRACKS, form);
            }
            onSaved();
        } catch (e: any) {
            setError(e.response?.data?.error ?? 'Erro ao salvar trilha.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm" onClick={onClose} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
                    <div className="flex items-center justify-between">
                        <h3 className="text-lg font-semibold">{isEdit ? 'Editar Trilha' : 'Nova Trilha de Revisão'}</h3>
                        <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {error && (
                        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">{error}</div>
                    )}

                    <div className="space-y-3">
                        <div>
                            <label className="text-sm font-medium block mb-1">Nome <span className="text-destructive">*</span></label>
                            <input
                                autoFocus
                                value={form.name}
                                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                placeholder="Ex: Jurídico"
                                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">Descrição</label>
                            <textarea
                                value={form.description}
                                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                                placeholder="Descreva o propósito desta trilha..."
                                rows={2}
                                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">SLA (horas) <span className="text-destructive">*</span></label>
                            <input
                                type="number"
                                min={1}
                                max={720}
                                value={form.sla_hours}
                                onChange={e => setForm(f => ({ ...f, sla_hours: Number(e.target.value) }))}
                                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                            <p className="text-xs text-muted-foreground mt-1">Tempo máximo para conclusão da revisão (1–720h)</p>
                        </div>
                        <div className="flex items-center justify-between py-1">
                            <div>
                                <div className="text-sm font-medium">Obrigatória</div>
                                <div className="text-xs text-muted-foreground">Bloqueia publicação enquanto pendente</div>
                            </div>
                            <Toggle checked={form.is_required} onChange={v => setForm(f => ({ ...f, is_required: v }))} />
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                        <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg text-sm border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
                            Cancelar
                        </button>
                        <button onClick={submit} disabled={saving} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {isEdit ? 'Salvar' : 'Criar'}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function SettingsPage() {
    const { role } = useAuth();
    const isAdmin = role === 'admin';

    // Org settings
    const [org, setOrg]                         = useState<OrgSettings | null>(null);
    const [hitlHours, setHitlHours]             = useState(4);
    const [savingOrg, setSavingOrg]             = useState(false);

    // Review tracks
    const [tracks, setTracks]                   = useState<ReviewTrack[]>([]);
    const [tracksLoading, setTracksLoading]     = useState(true);
    const [trackModal, setTrackModal]           = useState<{ open: boolean; target?: ReviewTrack }>({ open: false });
    const [deleting, setDeleting]               = useState<string | null>(null);
    const [reordering, setReordering]           = useState(false);

    // Retention
    const [retention, setRetention]             = useState<RetentionConfig>({ audit_log_retention_days: 365, archive_enabled: false });
    const [retentionDays, setRetentionDays]     = useState(365);
    const [archiveEnabled, setArchiveEnabled]   = useState(false);
    const [previewCount, setPreviewCount]       = useState<number | null>(null);
    const [savingRetention, setSavingRetention] = useState(false);
    const [previewLoading, setPreviewLoading]   = useState(false);

    // Alert thresholds (admin only)
    const [thresholds, setThresholds]           = useState<AlertThresholds>({ latency_p95_ms: 5000, violation_rate_pct: 10, daily_cost_usd: 50 });
    const [savingThresholds, setSavingThresholds] = useState(false);

    const { toast, toastEl } = useToast();

    // ── Load all ──────────────────────────────────────────────────────────
    const loadOrg = useCallback(async () => {
        try {
            const res = await api.get(ENDPOINTS.SETTINGS_ORGANIZATION);
            const data = res.data as OrgSettings;
            setOrg(data);
            setHitlHours(data.hitl_timeout_hours ?? 4);
        } catch { /* silent */ }
    }, []);

    const loadTracks = useCallback(async () => {
        setTracksLoading(true);
        try {
            const res = await api.get(ENDPOINTS.SETTINGS_REVIEW_TRACKS);
            setTracks(res.data as ReviewTrack[]);
        } catch { /* silent */ } finally {
            setTracksLoading(false);
        }
    }, []);

    const loadRetention = useCallback(async () => {
        try {
            const res = await api.get(ENDPOINTS.SETTINGS_RETENTION);
            const data = res.data as RetentionConfig;
            setRetention(data);
            setRetentionDays(data.audit_log_retention_days);
            setArchiveEnabled(data.archive_enabled);
        } catch { /* silent */ }
    }, []);

    const loadThresholds = useCallback(async () => {
        if (!isAdmin) return;
        try {
            const res = await api.get(ENDPOINTS.MONITORING_THRESHOLDS);
            setThresholds(res.data as AlertThresholds);
        } catch { /* silent */ }
    }, [isAdmin]);

    useEffect(() => {
        loadOrg();
        loadTracks();
        loadRetention();
        loadThresholds();
    }, [loadOrg, loadTracks, loadRetention, loadThresholds]);

    // ── Preview retention ─────────────────────────────────────────────────
    const loadPreview = useCallback(async (days: number) => {
        if (days < 90 || days > 2555) return;
        setPreviewLoading(true);
        try {
            const res = await api.get(ENDPOINTS.SETTINGS_RETENTION_PREVIEW(days));
            setPreviewCount((res.data as any).count);
        } catch { /* silent */ } finally {
            setPreviewLoading(false);
        }
    }, []);

    useEffect(() => {
        const t = setTimeout(() => loadPreview(retentionDays), 600);
        return () => clearTimeout(t);
    }, [retentionDays, loadPreview]);

    // ── Save org ──────────────────────────────────────────────────────────
    const saveOrg = async () => {
        if (hitlHours < 1 || hitlHours > 168) { toast('HITL timeout deve ser entre 1 e 168 horas.', 'error'); return; }
        setSavingOrg(true);
        try {
            await api.put(ENDPOINTS.SETTINGS_ORGANIZATION, { hitl_timeout_hours: hitlHours });
            toast('Configuração salva com sucesso!');
            loadOrg();
        } catch (e: any) {
            toast(e.response?.data?.error ?? 'Erro ao salvar.', 'error');
        } finally {
            setSavingOrg(false);
        }
    };

    // ── Delete track ──────────────────────────────────────────────────────
    const deleteTrack = async (id: string) => {
        setDeleting(id);
        try {
            await api.delete(ENDPOINTS.SETTINGS_REVIEW_TRACK(id));
            toast('Trilha removida.');
            loadTracks();
        } catch (e: any) {
            toast(e.response?.data?.error ?? 'Erro ao remover trilha.', 'error');
        } finally {
            setDeleting(null);
        }
    };

    // ── Reorder track ─────────────────────────────────────────────────────
    const moveTrack = async (idx: number, dir: 'up' | 'down') => {
        const newTracks = [...tracks];
        const target = dir === 'up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= newTracks.length) return;
        [newTracks[idx], newTracks[target]] = [newTracks[target], newTracks[idx]];
        setTracks(newTracks);
        setReordering(true);
        try {
            await api.post(ENDPOINTS.SETTINGS_TRACKS_REORDER, { track_ids: newTracks.map(t => t.id) });
        } catch { /* silently revert */ loadTracks(); }
        finally { setReordering(false); }
    };

    // ── Save thresholds ───────────────────────────────────────────────────
    const saveThresholds = async () => {
        if (thresholds.latency_p95_ms < 100 || thresholds.latency_p95_ms > 60000) {
            toast('Latência P95 deve ser entre 100 e 60000 ms.', 'error'); return;
        }
        if (thresholds.violation_rate_pct < 0 || thresholds.violation_rate_pct > 100) {
            toast('Taxa de violação deve ser entre 0 e 100%.', 'error'); return;
        }
        if (thresholds.daily_cost_usd < 0 || thresholds.daily_cost_usd > 100000) {
            toast('Custo diário deve ser entre 0 e 100000 USD.', 'error'); return;
        }
        setSavingThresholds(true);
        try {
            await api.put(ENDPOINTS.MONITORING_THRESHOLDS, thresholds);
            toast('Thresholds de alerta salvos!');
            loadThresholds();
        } catch (e: any) {
            toast(e.response?.data?.error ?? 'Erro ao salvar thresholds.', 'error');
        } finally {
            setSavingThresholds(false);
        }
    };

    // ── Save retention ────────────────────────────────────────────────────
    const saveRetention = async () => {
        if (retentionDays < 90 || retentionDays > 2555) {
            toast('Período deve ser entre 90 e 2555 dias.', 'error'); return;
        }
        setSavingRetention(true);
        try {
            await api.put(ENDPOINTS.SETTINGS_RETENTION, {
                audit_log_retention_days: retentionDays,
                archive_enabled: archiveEnabled,
            });
            toast('Configuração de retenção salva!');
            loadRetention();
        } catch (e: any) {
            toast(e.response?.data?.error ?? 'Erro ao salvar.', 'error');
        } finally {
            setSavingRetention(false);
        }
    };

    // ── Helpers ───────────────────────────────────────────────────────────
    const daysLabel = (days: number) => {
        const years = Math.floor(days / 365);
        const months = Math.floor((days % 365) / 30);
        if (years > 0 && months > 0) return `≈ ${years} ano${years > 1 ? 's' : ''} e ${months} mês${months > 1 ? 'es' : ''}`;
        if (years > 0) return `≈ ${years} ano${years > 1 ? 's' : ''}`;
        return `≈ ${months} mês${months > 1 ? 'es' : ''}`;
    };

    const fmtDate = (d?: string | null) => {
        if (!d) return 'nunca executado';
        return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    };

    const retentionValid = retentionDays >= 90 && retentionDays <= 2555;

    return (
        <div className="flex-1 overflow-auto">
            {toastEl}
            <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-0">

                <PageHeader
                    title="Configurações"
                    subtitle="Parâmetros da organização, trilhas de revisão e política de retenção"
                    icon={<Settings className="w-5 h-5" />}
                />

                {/* ── SEÇÃO 1: Organização ─────────────────────────────── */}
                <Section title="Organização">
                    <div className="space-y-5">
                        <div>
                            <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Nome</label>
                            <p className="text-base font-semibold mt-1">{org?.name ?? '—'}</p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium block">
                                Timeout de Aprovação HITL
                                <span className="ml-2 text-xs text-muted-foreground font-normal">(1–168 horas)</span>
                            </label>
                            <div className="flex items-center gap-3">
                                <input
                                    type="number"
                                    min={1}
                                    max={168}
                                    value={hitlHours}
                                    onChange={e => setHitlHours(Number(e.target.value))}
                                    className="w-28 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                />
                                <span className="text-sm text-muted-foreground">horas</span>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed max-w-lg">
                                Quando um prompt aciona palavras-chave sensíveis, a execução é pausada para aprovação humana.
                                Este é o tempo máximo de espera antes do timeout automático.
                            </p>
                        </div>

                        <button
                            onClick={saveOrg}
                            disabled={savingOrg}
                            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                        >
                            {savingOrg ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Salvar
                        </button>
                    </div>
                </Section>

                {/* ── SEÇÃO 2: Trilhas de Revisão ───────────────────────── */}
                <Section
                    title="Trilhas de Revisão"
                    action={
                        <button
                            onClick={() => setTrackModal({ open: true })}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                            Nova Trilha
                        </button>
                    }
                >
                    {tracksLoading ? (
                        <div className="space-y-2">
                            {[1,2,3].map(i => <div key={i} className="h-12 bg-secondary/40 rounded-lg animate-pulse" />)}
                        </div>
                    ) : tracks.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">Nenhuma trilha configurada.</p>
                    ) : (
                        <div className="space-y-2">
                            {tracks.map((track, idx) => (
                                <div key={track.id} className="flex items-center gap-3 p-3 bg-secondary/20 border border-border/50 rounded-lg hover:border-border transition-colors">
                                    {/* Reorder buttons */}
                                    <div className="flex flex-col gap-0.5">
                                        <button
                                            onClick={() => moveTrack(idx, 'up')}
                                            disabled={idx === 0 || reordering}
                                            className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                                        >
                                            <ChevronUp className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={() => moveTrack(idx, 'down')}
                                            disabled={idx === tracks.length - 1 || reordering}
                                            className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                                        >
                                            <ChevronDown className="w-3.5 h-3.5" />
                                        </button>
                                    </div>

                                    {/* Track info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium text-sm text-foreground">{track.name}</span>
                                            <span className="text-xs font-mono text-muted-foreground px-1.5 py-0.5 bg-secondary border border-border rounded">
                                                {track.sla_hours}h SLA
                                            </span>
                                            {track.is_required && (
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-amber-500/10 border-amber-500/20 text-amber-400">
                                                    OBRIGATÓRIA
                                                </span>
                                            )}
                                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                                                track.is_active
                                                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                                    : 'bg-secondary border-border text-muted-foreground'
                                            }`}>
                                                {track.is_active ? 'ATIVA' : 'INATIVA'}
                                            </span>
                                        </div>
                                        {track.description && (
                                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{track.description}</p>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => setTrackModal({ open: true, target: track })}
                                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                                            title="Editar"
                                        >
                                            <Edit2 className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (confirm(`Remover a trilha "${track.name}"? Esta ação não pode ser desfeita.`)) {
                                                    deleteTrack(track.id);
                                                }
                                            }}
                                            disabled={deleting === track.id}
                                            className="p-1.5 rounded-lg text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                                            title="Remover"
                                        >
                                            {deleting === track.id
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                : <Trash2 className="w-3.5 h-3.5" />
                                            }
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <p className="text-xs text-muted-foreground mt-3">
                        Ao submeter um assistente para revisão, serão criadas decisões pendentes em cada trilha ativa.
                        A publicação só é permitida após todas as trilhas obrigatórias serem aprovadas.
                    </p>
                </Section>

                {/* ── SEÇÃO 3: Política de Retenção ────────────────────── */}
                <Section title="Política de Retenção de Logs">
                    <div className="space-y-5">

                        {/* Retention days */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium block">
                                Período de retenção
                                {retentionDays >= 90 && (
                                    <span className="ml-2 text-xs text-muted-foreground font-normal">
                                        {daysLabel(retentionDays)}
                                    </span>
                                )}
                            </label>
                            <div className="flex items-center gap-3">
                                <input
                                    type="number"
                                    min={90}
                                    max={2555}
                                    value={retentionDays}
                                    onChange={e => setRetentionDays(Number(e.target.value))}
                                    className={`w-28 bg-secondary border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 ${
                                        !retentionValid ? 'border-destructive ring-1 ring-destructive/50' : 'border-border'
                                    }`}
                                />
                                <span className="text-sm text-muted-foreground">dias</span>
                            </div>
                            {!retentionValid && (
                                <p className="text-xs text-destructive">Mínimo: 90 dias (requisito regulatório) | Máximo: 2.555 dias (7 anos)</p>
                            )}
                            {retentionValid && (
                                <p className="text-xs text-muted-foreground">
                                    Mínimo: 90 dias — requisito regulatório | Máximo: 2.555 dias / 7 anos
                                </p>
                            )}
                        </div>

                        {/* Archiving toggle */}
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                                <div className="text-sm font-medium flex items-center gap-2">
                                    Archiving automático
                                    {archiveEnabled
                                        ? <ToggleRight className="w-4 h-4 text-primary" />
                                        : <ToggleLeft className="w-4 h-4 text-muted-foreground" />
                                    }
                                </div>
                                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                                    Quando ativado, logs mais antigos que o período são movidos para tabela de arquivo diariamente às 03:30.
                                    Logs arquivados não são excluídos — são preservados em tabela separada para consulta.
                                </p>
                            </div>
                            <Toggle checked={archiveEnabled} onChange={setArchiveEnabled} />
                        </div>

                        {/* Info box */}
                        <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-1.5 text-sm">
                            <p className="font-semibold text-xs text-muted-foreground uppercase tracking-wider mb-2">Com a configuração atual:</p>
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">•</span>
                                {previewLoading
                                    ? <span className="text-muted-foreground text-xs animate-pulse">Calculando...</span>
                                    : <span>
                                        <strong className={previewCount && previewCount > 0 ? 'text-amber-400' : 'text-foreground'}>
                                            {previewCount?.toLocaleString('pt-BR') ?? 0}
                                        </strong>
                                        <span className="text-muted-foreground"> logs serão arquivados</span>
                                      </span>
                                }
                            </div>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <span>•</span>
                                Último archiving: <strong className="text-foreground ml-1">{fmtDate(retention.last_archive_run_at)}</strong>
                            </div>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <span>•</span>
                                Logs arquivados na última execução: <strong className="text-foreground ml-1">{retention.last_archive_count ?? 0}</strong>
                            </div>
                        </div>

                        <button
                            onClick={saveRetention}
                            disabled={savingRetention || !retentionValid}
                            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                        >
                            {savingRetention ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Salvar Configuração
                        </button>
                    </div>
                </Section>

                {/* ── SEÇÃO 4: Thresholds de Alerta (admin only) ─────── */}
                {isAdmin && (
                    <Section
                        title="Thresholds de Alerta"
                        action={
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Bell className="w-3.5 h-3.5" />
                                Dispara alertas no dashboard
                            </div>
                        }
                    >
                        <div className="space-y-5">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                Defina os limites que disparam alertas no painel de monitoramento.
                                Quando um KPI exceder o threshold, um alerta aparece no topo do dashboard.
                            </p>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                {/* Latency P95 */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium block">
                                        Latência P95
                                        <span className="ml-1 text-xs text-muted-foreground font-normal">(ms)</span>
                                    </label>
                                    <input
                                        type="number"
                                        min={100}
                                        max={60000}
                                        value={thresholds.latency_p95_ms}
                                        onChange={e => setThresholds(t => ({ ...t, latency_p95_ms: Number(e.target.value) }))}
                                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    />
                                    <p className="text-xs text-muted-foreground">Alerta quando P95 exceder este valor em ms</p>
                                </div>

                                {/* Violation Rate */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium block">
                                        Taxa de Violações
                                        <span className="ml-1 text-xs text-muted-foreground font-normal">(%)</span>
                                    </label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        step={0.1}
                                        value={thresholds.violation_rate_pct}
                                        onChange={e => setThresholds(t => ({ ...t, violation_rate_pct: Number(e.target.value) }))}
                                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    />
                                    <p className="text-xs text-muted-foreground">% de violações sobre total de execuções</p>
                                </div>

                                {/* Daily Cost */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium block">
                                        Custo Diário
                                        <span className="ml-1 text-xs text-muted-foreground font-normal">(USD)</span>
                                    </label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100000}
                                        step={1}
                                        value={thresholds.daily_cost_usd}
                                        onChange={e => setThresholds(t => ({ ...t, daily_cost_usd: Number(e.target.value) }))}
                                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    />
                                    <p className="text-xs text-muted-foreground">Custo diário estimado em USD</p>
                                </div>
                            </div>

                            <button
                                onClick={saveThresholds}
                                disabled={savingThresholds}
                                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                            >
                                {savingThresholds ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                Salvar Thresholds
                            </button>
                        </div>
                    </Section>
                )}

            </div>

            {/* Track modal */}
            {trackModal.open && (
                <TrackModal
                    initial={trackModal.target}
                    onClose={() => setTrackModal({ open: false })}
                    onSaved={() => { setTrackModal({ open: false }); loadTracks(); toast('Trilha salva com sucesso!'); }}
                />
            )}
        </div>
    );
}
