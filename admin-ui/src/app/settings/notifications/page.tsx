'use client';

import { useCallback, useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import {
    Bell, Plus, Trash2, Loader2, Save, AlertCircle, CheckCircle2,
    X, Play, Pencil, ToggleLeft, ToggleRight, Eye, EyeOff,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

type Provider = 'slack' | 'teams' | 'email';

interface NotificationChannel {
    id: string;
    name: string;
    provider: Provider;
    config: {
        webhook_url?: string;
        recipients?: string[];
        smtp_from?: string;
    };
    events: string[];
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

interface NotifEvent {
    value: string;
    label: string;
    severity: 'critical' | 'warning' | 'info';
    category: 'compliance' | 'technical' | 'lifecycle';
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<Provider, string> = {
    slack:  'Slack',
    teams:  'Microsoft Teams',
    email:  'E-mail',
};

const PROVIDER_COLORS: Record<Provider, string> = {
    slack: 'bg-[#4A154B]/20 text-[#E01E5A] border-[#4A154B]/40',
    teams: 'bg-[#464EB8]/20 text-[#7B83EB] border-[#464EB8]/40',
    email: 'bg-success-bg text-success-fg border-success-border',
};

const SEVERITY_COLORS: Record<string, string> = {
    critical: 'bg-danger-bg text-danger-fg border-danger-border',
    warning:  'bg-warning-bg text-warning-fg border-warning-border',
    info:     'bg-info-bg text-info-fg border-info-border',
};

const CATEGORY_LABELS: Record<string, string> = {
    compliance: 'Compliance',
    technical:  'Técnico',
    lifecycle:  'Ciclo de Vida',
};

// Provider emoji icons (no SVG dependency)
const PROVIDER_EMOJI: Record<Provider, string> = {
    slack:  '⚡',
    teams:  '🟣',
    email:  '✉️',
};

// ── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <Bell className="w-12 h-12 mb-4 opacity-20" />
            <p className="text-sm font-medium mb-1">Nenhum canal configurado</p>
            <p className="text-xs mb-4">Configure canais Slack, Teams ou E-mail para receber alertas automáticos.</p>
            <button
                onClick={onAdd}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
                + Adicionar Canal
            </button>
        </div>
    );
}

// ── Channel Card ───────────────────────────────────────────────────────────
function ChannelCard({
    channel, events, onEdit, onDelete, onToggle, onTest, testing,
}: {
    channel:  NotificationChannel;
    events:   NotifEvent[];
    onEdit:   (ch: NotificationChannel) => void;
    onDelete: (id: string) => void;
    onToggle: (ch: NotificationChannel) => void;
    onTest:   (ch: NotificationChannel) => void;
    testing:  boolean;
}) {
    const eventMap = Object.fromEntries(events.map(e => [e.value, e]));
    const channelEvents = channel.events.map(v => eventMap[v]).filter(Boolean);

    return (
        <div className={`bg-card border rounded-xl p-5 transition-opacity ${channel.is_active ? 'border-border opacity-100' : 'border-border/40 opacity-60'}`}>
            <div className="flex items-start justify-between gap-4">
                {/* Left: icon + name + badge */}
                <div className="flex items-start gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center text-xl shrink-0 mt-0.5">
                        {PROVIDER_EMOJI[channel.provider]}
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-foreground text-sm truncate">{channel.name}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${PROVIDER_COLORS[channel.provider]}`}>
                                {PROVIDER_LABELS[channel.provider]}
                            </span>
                            {!channel.is_active && (
                                <span className="text-xs px-2 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border">
                                    Inativo
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {channel.provider !== 'email'
                                ? `Webhook: ${channel.config.webhook_url ? channel.config.webhook_url.slice(0, 50) + '…' : '—'}`
                                : `Destinatários: ${(channel.config.recipients || []).join(', ').slice(0, 60) || '—'}`
                            }
                        </p>
                        {/* Events */}
                        {channelEvents.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                {channelEvents.slice(0, 5).map(ev => (
                                    <span key={ev.value} className={`text-xs px-1.5 py-0.5 rounded-md border font-medium ${SEVERITY_COLORS[ev.severity]}`}>
                                        {ev.label}
                                    </span>
                                ))}
                                {channelEvents.length > 5 && (
                                    <span className="text-xs px-1.5 py-0.5 rounded-md border bg-secondary text-muted-foreground border-border">
                                        +{channelEvents.length - 5}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Right: actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                    {/* Toggle active */}
                    <button
                        onClick={() => onToggle(channel)}
                        title={channel.is_active ? 'Desativar' : 'Ativar'}
                        className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                    >
                        {channel.is_active
                            ? <ToggleRight className="w-4 h-4 text-success-fg" />
                            : <ToggleLeft className="w-4 h-4" />}
                    </button>
                    {/* Test */}
                    <button
                        onClick={() => onTest(channel)}
                        disabled={testing || !channel.is_active}
                        title="Testar"
                        className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    </button>
                    {/* Edit */}
                    <button
                        onClick={() => onEdit(channel)}
                        title="Editar"
                        className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                    >
                        <Pencil className="w-4 h-4" />
                    </button>
                    {/* Delete */}
                    <button
                        onClick={() => onDelete(channel.id)}
                        title="Remover"
                        className="p-2 rounded-lg hover:bg-danger-bg transition-colors text-muted-foreground hover:text-danger-fg"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Add/Edit Modal ─────────────────────────────────────────────────────────
function ChannelModal({
    initial, events, onClose, onSaved,
}: {
    initial: NotificationChannel | null;
    events:  NotifEvent[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const isEdit = !!initial;

    const [name,       setName]       = useState(initial?.name       ?? '');
    const [provider,   setProvider]   = useState<Provider>(initial?.provider ?? 'slack');
    const [webhookUrl, setWebhookUrl] = useState(initial?.config.webhook_url  ?? '');
    const [recipients, setRecipients] = useState((initial?.config.recipients ?? []).join(', '));
    const [selEvents,  setSelEvents]  = useState<string[]>(initial?.events    ?? []);
    const [isActive,   setIsActive]   = useState(initial?.is_active ?? true);
    const [saving,     setSaving]     = useState(false);
    const [error,      setError]      = useState('');
    const [showPreview, setShowPreview] = useState(false);
    const [previewData, setPreviewData] = useState<object | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);

    // Group events by category
    const groupedEvents: Record<string, NotifEvent[]> = {};
    for (const ev of events) {
        if (!groupedEvents[ev.category]) groupedEvents[ev.category] = [];
        groupedEvents[ev.category].push(ev);
    }

    function toggleEvent(value: string) {
        setSelEvents(prev =>
            prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]
        );
    }

    function selectAll(category: string) {
        const catEvents = (groupedEvents[category] ?? []).map(e => e.value);
        const allSelected = catEvents.every(v => selEvents.includes(v));
        if (allSelected) {
            setSelEvents(prev => prev.filter(v => !catEvents.includes(v)));
        } else {
            setSelEvents(prev => Array.from(new Set([...prev, ...catEvents])));
        }
    }

    async function loadPreview() {
        if (provider === 'email') return;
        const event = selEvents[0] || 'policy.violation';
        setLoadingPreview(true);
        try {
            const res = await api.get(ENDPOINTS.NOTIFICATION_CHANNELS_PREVIEW, {
                params: { provider, event },
            });
            setPreviewData(res.data);
        } catch {
            setPreviewData(null);
        } finally {
            setLoadingPreview(false);
        }
    }

    useEffect(() => {
        if (showPreview) loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showPreview, provider, selEvents]);

    async function handleSave() {
        if (!name.trim()) { setError('Nome é obrigatório.'); return; }
        if ((provider === 'slack' || provider === 'teams') && !webhookUrl.trim()) {
            setError('Webhook URL é obrigatório para Slack/Teams.'); return;
        }
        if (provider === 'email') {
            const recs = recipients.split(',').map(r => r.trim()).filter(Boolean);
            if (recs.length === 0) { setError('Informe ao menos um destinatário.'); return; }
        }

        setSaving(true);
        setError('');
        try {
            const body = {
                name: name.trim(),
                provider,
                config: provider !== 'email'
                    ? { webhook_url: webhookUrl.trim() }
                    : { recipients: recipients.split(',').map(r => r.trim()).filter(Boolean) },
                events: selEvents,
                is_active: isActive,
            };

            if (isEdit && initial) {
                await api.put(ENDPOINTS.NOTIFICATION_CHANNEL(initial.id), body);
            } else {
                await api.post(ENDPOINTS.NOTIFICATION_CHANNELS, body);
            }
            onSaved();
            onClose();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao salvar canal.');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
            <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <h2 className="text-lg font-semibold text-foreground">
                        {isEdit ? 'Editar Canal' : 'Adicionar Canal de Notificação'}
                    </h2>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6 space-y-5">
                    {error && (
                        <div className="flex items-center gap-2 p-3 bg-danger-bg border border-danger-border rounded-lg text-danger-fg text-sm">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            {error}
                        </div>
                    )}

                    {/* Name */}
                    <div>
                        <label className="block text-sm font-medium text-foreground mb-1.5">Nome do Canal</label>
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="ex. Alertas de Compliance"
                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                    </div>

                    {/* Provider */}
                    <div>
                        <label className="block text-sm font-medium text-foreground mb-1.5">Provedor</label>
                        <div className="grid grid-cols-3 gap-2">
                            {(['slack', 'teams', 'email'] as Provider[]).map(p => (
                                <button
                                    key={p}
                                    type="button"
                                    onClick={() => setProvider(p)}
                                    className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                                        provider === p
                                            ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/50'
                                            : 'border-border bg-secondary/30 text-muted-foreground hover:border-border/80 hover:text-foreground'
                                    }`}
                                >
                                    {PROVIDER_EMOJI[p]} {PROVIDER_LABELS[p]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Webhook URL (Slack / Teams) */}
                    {(provider === 'slack' || provider === 'teams') && (
                        <div>
                            <label className="block text-sm font-medium text-foreground mb-1.5">
                                Webhook URL
                                <span className="ml-1 text-xs text-muted-foreground font-normal">
                                    {provider === 'slack'
                                        ? '(Incoming Webhooks — api.slack.com/apps)'
                                        : '(Connectors — teams.microsoft.com)'}
                                </span>
                            </label>
                            <input
                                type="url"
                                value={webhookUrl}
                                onChange={e => setWebhookUrl(e.target.value)}
                                placeholder={provider === 'slack'
                                    ? 'https://hooks.slack.com/services/T.../B.../...'
                                    : 'https://outlook.office.com/webhook/...'}
                                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                            />
                        </div>
                    )}

                    {/* Recipients (Email) */}
                    {provider === 'email' && (
                        <div>
                            <label className="block text-sm font-medium text-foreground mb-1.5">
                                Destinatários <span className="text-xs text-muted-foreground font-normal">(separados por vírgula)</span>
                            </label>
                            <textarea
                                value={recipients}
                                onChange={e => setRecipients(e.target.value)}
                                rows={2}
                                placeholder="ciso@empresa.com, dpo@empresa.com"
                                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                            />
                            <p className="text-xs text-muted-foreground mt-1">
                                A integração SMTP deve ser configurada separadamente nas variáveis de ambiente.
                            </p>
                        </div>
                    )}

                    {/* Events */}
                    <div>
                        <label className="block text-sm font-medium text-foreground mb-2">
                            Eventos <span className="text-xs text-muted-foreground font-normal">(selecione quais eventos disparam esta notificação)</span>
                        </label>
                        <div className="space-y-3">
                            {Object.entries(groupedEvents).map(([category, catEvents]) => {
                                const allSelected = catEvents.every(e => selEvents.includes(e.value));
                                const someSelected = catEvents.some(e => selEvents.includes(e.value));
                                return (
                                    <div key={category} className="border border-border rounded-lg p-3 bg-secondary/10">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                                {CATEGORY_LABELS[category] ?? category}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => selectAll(category)}
                                                className="text-xs text-primary hover:opacity-80 transition-opacity"
                                            >
                                                {allSelected ? 'Desmarcar todos' : someSelected ? 'Selecionar todos' : 'Selecionar todos'}
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                            {catEvents.map(ev => (
                                                <label key={ev.value} className="flex items-center gap-2 cursor-pointer group">
                                                    <input
                                                        type="checkbox"
                                                        checked={selEvents.includes(ev.value)}
                                                        onChange={() => toggleEvent(ev.value)}
                                                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50 bg-background shrink-0"
                                                    />
                                                    <span className="text-sm text-foreground group-hover:text-foreground/80 truncate">{ev.label}</span>
                                                    <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${SEVERITY_COLORS[ev.severity]}`}>
                                                        {ev.severity === 'critical' ? '🔴' : ev.severity === 'warning' ? '🟡' : '🔵'}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Preview toggle (Slack / Teams only) */}
                    {(provider === 'slack' || provider === 'teams') && (
                        <div>
                            <button
                                type="button"
                                onClick={() => setShowPreview(p => !p)}
                                className="flex items-center gap-2 text-sm text-primary hover:opacity-80 transition-opacity"
                            >
                                {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                {showPreview ? 'Ocultar preview do payload' : 'Ver preview do payload'}
                            </button>
                            {showPreview && (
                                <div className="mt-2 rounded-lg bg-background border border-border overflow-hidden">
                                    <div className="flex items-center justify-between px-3 py-2 bg-secondary/20 border-b border-border">
                                        <span className="text-xs font-mono text-muted-foreground">
                                            {provider === 'slack' ? 'Slack Blocks API payload' : 'Teams Adaptive Card payload'}
                                        </span>
                                        {loadingPreview && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                                    </div>
                                    <pre className="text-xs text-muted-foreground p-3 overflow-auto max-h-48 font-mono leading-relaxed">
                                        {previewData
                                            ? JSON.stringify(previewData, null, 2)
                                            : '— Selecione um evento para ver o preview —'}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Active toggle */}
                    <div className="flex items-center gap-3 pt-2">
                        <button
                            type="button"
                            onClick={() => setIsActive(p => !p)}
                            className="transition-colors"
                        >
                            {isActive
                                ? <ToggleRight className="w-7 h-7 text-success-fg" />
                                : <ToggleLeft  className="w-7 h-7 text-muted-foreground" />}
                        </button>
                        <span className="text-sm text-foreground">Canal ativo</span>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-background/30">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary/50 transition-colors"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        {isEdit ? 'Salvar alterações' : 'Criar Canal'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Delete Confirm ─────────────────────────────────────────────────────────
function DeleteConfirm({ name, onConfirm, onCancel, deleting }: {
    name:      string;
    onConfirm: () => void;
    onCancel:  () => void;
    deleting:  boolean;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
            <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-danger-bg flex items-center justify-center">
                        <Trash2 className="w-5 h-5 text-danger-fg" />
                    </div>
                    <div>
                        <h3 className="font-semibold text-foreground text-sm">Remover canal</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">Esta ação não pode ser desfeita.</p>
                    </div>
                </div>
                <p className="text-sm text-muted-foreground mb-5">
                    Tem certeza que deseja remover o canal <strong className="text-foreground">{name}</strong>?
                </p>
                <div className="flex gap-3">
                    <button
                        onClick={onCancel}
                        className="flex-1 px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary/50 transition-colors"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={deleting}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-rose-500 text-white rounded-lg text-sm font-medium hover:bg-rose-600 transition-colors disabled:opacity-60"
                    >
                        {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        Remover
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Toast ──────────────────────────────────────────────────────────────────
function Toast({ message, type }: { message: string; type: 'success' | 'error' }) {
    return (
        <div className={`fixed bottom-6 right-6 z-[60] flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium border ${
            type === 'success'
                ? 'bg-emerald-950 border-success-border text-success-fg'
                : 'bg-rose-950 border-danger-border text-danger-fg'
        }`}>
            {type === 'success'
                ? <CheckCircle2 className="w-4 h-4 shrink-0" />
                : <AlertCircle className="w-4 h-4 shrink-0" />}
            {message}
        </div>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function NotificationsPage() {
    const [channels, setChannels]     = useState<NotificationChannel[]>([]);
    const [events,   setEvents]       = useState<NotifEvent[]>([]);
    const [loading,  setLoading]      = useState(true);
    const [showModal,    setShowModal]    = useState(false);
    const [editingCh,    setEditingCh]    = useState<NotificationChannel | null>(null);
    const [deletingId,   setDeletingId]   = useState<string | null>(null);
    const [deletingName, setDeletingName] = useState('');
    const [deletingNow,  setDeletingNow]  = useState(false);
    const [testingId,    setTestingId]    = useState<string | null>(null);
    const [toast,        setToast]        = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    const showToast = useCallback((message: string, type: 'success' | 'error') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    }, []);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [chRes, evRes] = await Promise.all([
                api.get(ENDPOINTS.NOTIFICATION_CHANNELS),
                api.get(ENDPOINTS.NOTIFICATION_CHANNELS_EVENTS),
            ]);
            setChannels(chRes.data);
            setEvents(evRes.data);
        } catch {
            showToast('Erro ao carregar canais de notificação.', 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { loadData(); }, [loadData]);

    async function handleToggle(ch: NotificationChannel) {
        try {
            await api.put(ENDPOINTS.NOTIFICATION_CHANNEL(ch.id), { is_active: !ch.is_active });
            setChannels(prev => prev.map(c =>
                c.id === ch.id ? { ...c, is_active: !c.is_active } : c
            ));
            showToast(ch.is_active ? 'Canal desativado.' : 'Canal ativado.', 'success');
        } catch {
            showToast('Erro ao alterar status do canal.', 'error');
        }
    }

    async function handleDelete() {
        if (!deletingId) return;
        setDeletingNow(true);
        try {
            await api.delete(ENDPOINTS.NOTIFICATION_CHANNEL(deletingId));
            setChannels(prev => prev.filter(c => c.id !== deletingId));
            showToast('Canal removido com sucesso.', 'success');
        } catch {
            showToast('Erro ao remover canal.', 'error');
        } finally {
            setDeletingNow(false);
            setDeletingId(null);
            setDeletingName('');
        }
    }

    async function handleTest(ch: NotificationChannel) {
        setTestingId(ch.id);
        try {
            const res = await api.post(ENDPOINTS.NOTIFICATION_CHANNELS_TEST, {
                channel_id: ch.id,
                event: ch.events[0] || 'policy.violation',
            });
            if (res.data.success) {
                showToast('Notificação de teste enviada!', 'success');
            } else {
                showToast(res.data.error || 'Falha no teste.', 'error');
            }
        } catch (err: any) {
            showToast(err.response?.data?.error || 'Erro ao testar canal.', 'error');
        } finally {
            setTestingId(null);
        }
    }

    // Loading
    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-5xl mx-auto p-4 sm:p-6">
                <PageHeader
                    title="Canais de Notificação"
                    subtitle="Configure webhooks Slack, Teams ou e-mail para receber alertas automáticos de governança."
                    icon={<Bell className="w-5 h-5" />}
                    actions={
                        <button
                            onClick={() => { setEditingCh(null); setShowModal(true); }}
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                        >
                            <Plus className="w-4 h-4" />
                            Adicionar Canal
                        </button>
                    }
                />

                {/* Info box */}
                <div className="mb-6 p-4 bg-blue-500/5 border border-info-border rounded-xl text-sm text-info-fg">
                    <strong className="text-blue-200">Como funciona:</strong> Configure um canal por provedor e selecione os eventos que devem disparar notificações. O GovAI enviará payloads formatados com Slack Blocks API ou Teams Adaptive Cards automaticamente.
                </div>

                {/* Channel list */}
                {channels.length === 0
                    ? <EmptyState onAdd={() => { setEditingCh(null); setShowModal(true); }} />
                    : (
                        <div className="space-y-3">
                            {channels.map(ch => (
                                <ChannelCard
                                    key={ch.id}
                                    channel={ch}
                                    events={events}
                                    onEdit={c => { setEditingCh(c); setShowModal(true); }}
                                    onDelete={id => {
                                        setDeletingId(id);
                                        setDeletingName(channels.find(c => c.id === id)?.name ?? '');
                                    }}
                                    onToggle={handleToggle}
                                    onTest={handleTest}
                                    testing={testingId === ch.id}
                                />
                            ))}
                        </div>
                    )
                }

                {/* Event catalogue reference */}
                {events.length > 0 && (
                    <div className="mt-8 bg-card border border-border rounded-xl p-5">
                        <h3 className="text-sm font-semibold text-foreground mb-3">Catálogo de Eventos</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {events.map(ev => (
                                <div key={ev.value} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/20">
                                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                                        ev.severity === 'critical' ? 'bg-rose-400' :
                                        ev.severity === 'warning'  ? 'bg-amber-400' : 'bg-blue-400'
                                    }`} />
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium text-foreground truncate">{ev.label}</p>
                                        <p className="text-[10px] text-muted-foreground font-mono truncate">{ev.value}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Modals */}
            {showModal && (
                <ChannelModal
                    initial={editingCh}
                    events={events}
                    onClose={() => { setShowModal(false); setEditingCh(null); }}
                    onSaved={() => { loadData(); showToast(editingCh ? 'Canal atualizado.' : 'Canal criado com sucesso.', 'success'); }}
                />
            )}

            {deletingId && (
                <DeleteConfirm
                    name={deletingName}
                    onConfirm={handleDelete}
                    onCancel={() => { setDeletingId(null); setDeletingName(''); }}
                    deleting={deletingNow}
                />
            )}

            {toast && <Toast message={toast.message} type={toast.type} />}
        </div>
    );
}
