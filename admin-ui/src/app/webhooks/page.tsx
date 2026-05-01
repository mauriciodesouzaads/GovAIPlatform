'use client';

import { useCallback, useEffect, useState } from 'react';
import {
    Bell, Plus, X, Check, AlertTriangle, ChevronDown, ChevronUp,
    Loader2, Trash2, Edit2, RefreshCw,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

// ── Types ──────────────────────────────────────────────────────────────────

interface Webhook {
    id: string;
    name: string;
    url: string;
    events: string[];
    is_active: boolean;
    created_at: string;
    updated_at?: string;
}

interface Delivery {
    id: string;
    event: string;
    status: 'success' | 'failed' | 'retrying';
    response_code: number | null;
    attempts: number;
    next_retry_at: string | null;
    created_at: string;
}

const ALL_EVENTS = [
    'execution.success', 'execution.violation',
    'approval.pending', 'approval.granted', 'approval.rejected',
    'exit.perimeter', 'shield.critical_finding',
    'assistant.published', 'review.completed', 'exception.expiring',
    'policy.updated',
];

function statusBadge(status: string) {
    switch (status) {
        case 'success':  return 'bg-success-bg text-success-fg border-emerald-500/20';
        case 'failed':   return 'bg-danger-bg text-danger-fg border-rose-500/20';
        case 'retrying': return 'bg-warning-bg text-warning-fg border-amber-500/20';
        default:         return 'bg-secondary text-muted-foreground border-border';
    }
}

function fmtDate(d?: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// ── Webhook Form Modal ─────────────────────────────────────────────────────

interface FormData { name: string; url: string; secret: string; events: string[]; is_active: boolean; }

interface FormModalProps {
    initial?: Partial<FormData> & { id?: string };
    onClose: () => void;
    onSaved: () => void;
}

function WebhookFormModal({ initial, onClose, onSaved }: FormModalProps) {
    const [form, setForm] = useState<FormData>({
        name: initial?.name ?? '',
        url: initial?.url ?? '',
        secret: initial?.secret ?? '',
        events: initial?.events ?? [],
        is_active: initial?.is_active ?? true,
    });
    const [loading, setLoading] = useState(false);
    const { toast } = useToast();
    const isEdit = !!initial?.id;

    const toggleEvent = (ev: string) => {
        setForm(f => ({
            ...f,
            events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev],
        }));
    };

    const submit = async () => {
        if (!form.name.trim()) return toast('Nome obrigatório', 'error');
        if (!form.url.startsWith('http')) return toast('URL inválida', 'error');
        setLoading(true);
        try {
            const body = { ...form, secret: form.secret || undefined };
            if (isEdit) {
                await api.put(ENDPOINTS.WEBHOOK(initial!.id!), body);
                toast('Webhook atualizado', 'success');
            } else {
                await api.post(ENDPOINTS.WEBHOOKS, body);
                toast('Webhook criado', 'success');
            }
            onSaved();
            onClose();
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <div className="fixed inset-0 bg-background/70 backdrop-blur-sm z-50" onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center z-[60] p-4" role="dialog" aria-modal="true">
                <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between">
                        <h3 className="text-base font-semibold text-foreground">
                            {isEdit ? 'Editar Webhook' : 'Novo Webhook'}
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="space-y-4">
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Nome *</label>
                            <input
                                value={form.name}
                                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-amber-500/50"
                                placeholder="Ex: Slack #govai-alerts"
                            />
                        </div>

                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">URL do Endpoint *</label>
                            <input
                                value={form.url}
                                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                                className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-amber-500/50 font-mono"
                                placeholder="https://hooks.slack.com/..."
                            />
                        </div>

                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Secret HMAC (opcional)</label>
                            <input
                                value={form.secret}
                                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
                                type="password"
                                className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-amber-500/50 font-mono"
                                placeholder="Usado para assinar o payload (X-GovAI-Signature)"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                                Eventos
                                <span className="text-[10px] font-normal normal-case">
                                    {form.events.length === 0 ? 'Todos os eventos' : `${form.events.length} selecionado(s)`}
                                </span>
                            </label>
                            <div className="grid grid-cols-2 gap-1.5">
                                {ALL_EVENTS.map(ev => (
                                    <button
                                        key={ev}
                                        type="button"
                                        onClick={() => toggleEvent(ev)}
                                        className={`text-left px-2 py-1.5 rounded-lg text-xs border transition-colors font-mono ${
                                            form.events.includes(ev)
                                                ? 'bg-warning-bg border-warning-border text-warning-fg'
                                                : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground'
                                        }`}
                                    >
                                        {ev}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-lg px-3 py-2.5">
                            <span className="text-sm text-foreground font-medium">Webhook ativo</span>
                            <button
                                type="button"
                                onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${form.is_active ? 'bg-emerald-500' : 'bg-secondary'}`}
                            >
                                <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform ${form.is_active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                    </div>

                    <div className="flex gap-2 justify-end pt-1">
                        <button
                            onClick={onClose}
                            disabled={loading}
                            className="px-4 py-2 rounded-lg text-sm border border-border text-muted-foreground hover:text-foreground hover:border-border-300 transition-colors disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                        <button
                            onClick={submit}
                            disabled={loading}
                            className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            {isEdit ? 'Salvar' : 'Criar'}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

// ── Deliveries Row ─────────────────────────────────────────────────────────

function DeliveryLog({ webhookId }: { webhookId: string }) {
    const [deliveries, setDeliveries] = useState<Delivery[]>([]);
    const [loading, setLoading] = useState(false);
    const [retrying, setRetrying] = useState<string | null>(null);
    const { toast } = useToast();

    const fetchDeliveries = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.WEBHOOK_DELIVERIES(webhookId));
            setDeliveries(res.data?.deliveries ?? []);
        } finally {
            setLoading(false);
        }
    }, [webhookId]);

    useEffect(() => { fetchDeliveries(); }, [fetchDeliveries]);

    const retry = async (deliveryId: string) => {
        setRetrying(deliveryId);
        try {
            await api.post(ENDPOINTS.WEBHOOK_DELIVERY_RETRY(webhookId, deliveryId));
            toast('Entrega reenviada para fila', 'success');
            fetchDeliveries();
        } catch (e: any) {
            toast(e.response?.data?.error ?? 'Erro ao reenviar', 'error');
        } finally {
            setRetrying(null);
        }
    };

    if (loading) return <div className="p-3 text-xs text-muted-foreground animate-pulse">Carregando entregas...</div>;
    if (deliveries.length === 0) return <div className="p-3 text-xs text-muted-foreground">Nenhuma entrega registrada.</div>;

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className="border-b border-border">
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-3">Evento</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-3">Status</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-3">HTTP</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-3">Tentativas</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-3">Data / Próxima</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2">Ação</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                    {deliveries.map(d => (
                        <tr key={d.id} className="hover:bg-secondary/20 transition-colors">
                            <td className="py-2 pr-3 font-mono text-foreground/80">{d.event}</td>
                            <td className="py-2 pr-3">
                                <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${statusBadge(d.status)}`}>
                                    {d.status.toUpperCase()}
                                </span>
                            </td>
                            <td className="py-2 pr-3 text-muted-foreground">{d.response_code ?? '—'}</td>
                            <td className="py-2 pr-3 text-muted-foreground">{d.attempts}</td>
                            <td className="py-2 pr-3 text-muted-foreground">
                                <span>{fmtDate(d.created_at)}</span>
                                {d.status === 'retrying' && d.next_retry_at && (
                                    <span className="block text-warning-fg mt-0.5">→ {fmtDate(d.next_retry_at)}</span>
                                )}
                            </td>
                            <td className="py-2">
                                {d.status === 'failed' && (
                                    <button
                                        onClick={() => retry(d.id)}
                                        disabled={retrying === d.id}
                                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border border-warning-border text-warning-fg hover:bg-warning-bg transition-colors disabled:opacity-50"
                                        title="Reenviar"
                                    >
                                        {retrying === d.id
                                            ? <Loader2 className="w-3 h-3 animate-spin" />
                                            : <RefreshCw className="w-3 h-3" />
                                        }
                                        Reenviar
                                    </button>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ── Webhook Row ────────────────────────────────────────────────────────────

function WebhookRow({ webhook, onEdit, onDeactivate }: {
    webhook: Webhook;
    onEdit: () => void;
    onDeactivate: () => void;
}) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="bg-card border border-border rounded-xl overflow-hidden hover:border-border/80 transition-colors">
            <div className="flex items-center gap-4 p-4">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-foreground">{webhook.name}</span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                            webhook.is_active
                                ? 'bg-success-bg text-success-fg border-emerald-500/20'
                                : 'bg-secondary text-muted-foreground border-border'
                        }`}>
                            {webhook.is_active ? 'ATIVO' : 'INATIVO'}
                        </span>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{webhook.url}</p>
                    {webhook.events.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                            {webhook.events.slice(0, 4).map(ev => (
                                <span key={ev} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary/50 border border-border text-muted-foreground">
                                    {ev}
                                </span>
                            ))}
                            {webhook.events.length > 4 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary/50 border border-border text-muted-foreground">
                                    +{webhook.events.length - 4}
                                </span>
                            )}
                            {webhook.events.length === 0 && (
                                <span className="text-[10px] text-muted-foreground italic">todos os eventos</span>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={onEdit}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        title="Editar"
                    >
                        <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    {webhook.is_active && (
                        <button
                            onClick={onDeactivate}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-danger-fg hover:bg-danger-bg transition-colors"
                            title="Desativar"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button
                        onClick={() => setExpanded(x => !x)}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        title="Ver entregas"
                    >
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                </div>
            </div>
            {expanded && (
                <div className="border-t border-border p-4 bg-secondary/10">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Histórico de Entregas</p>
                    <DeliveryLog webhookId={webhook.id} />
                </div>
            )}
        </div>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function WebhooksPage() {
    const [webhooks, setWebhooks] = useState<Webhook[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editTarget, setEditTarget] = useState<Webhook | null>(null);
    const { toast } = useToast();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.WEBHOOKS);
            setWebhooks(res.data?.webhooks ?? []);
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => { load(); }, [load]);

    const deactivate = async (id: string) => {
        try {
            await api.delete(ENDPOINTS.WEBHOOK(id));
            toast('Webhook desativado', 'success');
            load();
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        }
    };

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">

                <PageHeader
                    title="Webhooks"
                    subtitle="Notificações de eventos para sistemas externos"
                    icon={<Bell className="w-5 h-5" />}
                    actions={
                        <div className="flex items-center gap-2">
                            <button
                                onClick={load}
                                className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                                title="Recarregar"
                            >
                                <RefreshCw className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => { setEditTarget(null); setShowForm(true); }}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                                Novo Webhook
                            </button>
                        </div>
                    }
                />

                {/* Info banner */}
                <div className="flex items-start gap-3 p-4 bg-blue-500/5 border border-blue-500/20 rounded-xl text-xs text-info-fg">
                    <Bell className="w-4 h-4 shrink-0 mt-0.5 text-info-fg" />
                    <div>
                        <strong className="text-info-fg">Assinatura HMAC:</strong> payloads são assinados com{' '}
                        <code className="font-mono text-blue-200">X-GovAI-Signature: sha256=...</code> quando um secret é configurado.
                        Deixe o campo de eventos vazio para receber todos os eventos.
                    </div>
                </div>

                {loading ? (
                    <div className="space-y-3 animate-pulse">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="h-20 bg-secondary/50 border border-border rounded-xl" />
                        ))}
                    </div>
                ) : webhooks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
                        <Bell className="w-10 h-10 opacity-30" />
                        <p className="text-sm">Nenhum webhook configurado.</p>
                        <button
                            onClick={() => { setEditTarget(null); setShowForm(true); }}
                            className="text-xs text-warning-fg hover:underline"
                        >
                            Criar primeiro webhook
                        </button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {webhooks.map(wh => (
                            <WebhookRow
                                key={wh.id}
                                webhook={wh}
                                onEdit={() => { setEditTarget(wh); setShowForm(true); }}
                                onDeactivate={() => deactivate(wh.id)}
                            />
                        ))}
                    </div>
                )}

            </div>

            {showForm && (
                <WebhookFormModal
                    initial={editTarget ? { ...editTarget } : undefined}
                    onClose={() => { setShowForm(false); setEditTarget(null); }}
                    onSaved={load}
                />
            )}
        </div>
    );
}
