'use client';

import { useState, useEffect, useCallback } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import {
    ShieldCheck, Plus, X, ChevronDown, ChevronUp, Clock, History,
    Loader2, Save, AlertTriangle, Info, GitCompare,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// ── Types ──────────────────────────────────────────────────────────────────────

interface RulesJsonb {
    forbidden_topics: string[];
    pii_filter: boolean;
    strict_mode: boolean;
    hitl_enabled: boolean;
    hitl_keywords: string[];
    max_tokens: number;
}

interface PolicyVersion {
    id: string;
    name: string;
    version: number;
    rules_jsonb: RulesJsonb;
    created_at: string;
}

const DEFAULT_RULES: RulesJsonb = {
    forbidden_topics: [],
    pii_filter: true,
    strict_mode: false,
    hitl_enabled: false,
    hitl_keywords: [],
    max_tokens: 4096,
};

// ── Toggle Switch ─────────────────────────────────────────────────────────────

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

// ── Chip list editor ───────────────────────────────────────────────────────────

function ChipEditor({ items, onChange, placeholder, disabled }: {
    items: string[];
    onChange: (items: string[]) => void;
    placeholder: string;
    disabled?: boolean;
}) {
    const [input, setInput] = useState('');

    const add = () => {
        const v = input.trim();
        if (v && !items.includes(v)) {
            onChange([...items, v]);
            setInput('');
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
                {items.map(item => (
                    <span key={item} className="inline-flex items-center gap-1 bg-muted text-foreground rounded-full px-3 py-1 text-sm">
                        {item}
                        {!disabled && (
                            <button type="button" onClick={() => onChange(items.filter(i => i !== item))} className="text-muted-foreground hover:text-destructive transition-colors">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </span>
                ))}
                {items.length === 0 && <span className="text-sm text-muted-foreground italic">Nenhum item</span>}
            </div>
            {!disabled && (
                <div className="flex gap-2">
                    <input
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
                        placeholder={placeholder}
                        className="flex-1 bg-secondary border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <button type="button" onClick={add} className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded-md text-sm transition-colors">
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            )}
        </div>
    );
}

// ── Field section wrapper ─────────────────────────────────────────────────────

function FieldSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
    return (
        <div className="space-y-3 p-4 bg-background/50 border border-border/50 rounded-xl">
            <div>
                <div className="font-medium text-sm text-foreground">{title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
            </div>
            {children}
        </div>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────────

interface PolicyDiffChange {
    key: string;
    before: unknown;
    after: unknown;
    type: 'added' | 'removed' | 'changed' | 'unchanged';
}

interface PolicyDiff {
    from: { id: string; name: string; version: number };
    to:   { id: string; name: string; version: number };
    changes: PolicyDiffChange[];
    has_changes: boolean;
}

export default function PoliciesPage() {
    const [policies, setPolicies]         = useState<PolicyVersion[]>([]);
    const [selected, setSelected]         = useState<PolicyVersion | null>(null);
    const [history, setHistory]           = useState<PolicyVersion[]>([]);
    const [historyOpen, setHistoryOpen]   = useState(false);
    const [viewingOld, setViewingOld]     = useState(false);
    const [rules, setRules]               = useState<RulesJsonb>(DEFAULT_RULES);
    const [jsonOpen, setJsonOpen]         = useState(false);
    const [saving, setSaving]             = useState(false);
    const [toast, setToast]               = useState('');
    const [error, setError]               = useState('');
    const [newPolicyModal, setNewPolicyModal] = useState(false);
    const [newPolicyName, setNewPolicyName]   = useState('');
    const [creating, setCreating]         = useState(false);
    const [diffResult, setDiffResult]     = useState<PolicyDiff | null>(null);
    const [diffLoading, setDiffLoading]   = useState(false);

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(''), 3500);
    };

    const loadPolicies = useCallback(async () => {
        try {
            const res = await api.get(ENDPOINTS.GOV_POLICIES);
            setPolicies(res.data);
        } catch {
            setError('Erro ao carregar políticas');
        }
    }, []);

    useEffect(() => { loadPolicies(); }, [loadPolicies]);

    const selectPolicy = async (p: PolicyVersion) => {
        setSelected(p);
        setRules({ ...DEFAULT_RULES, ...p.rules_jsonb });
        setViewingOld(false);
        setHistoryOpen(false);
        setError('');
        // Load history
        try {
            const res = await api.get(ENDPOINTS.GOV_POLICY_HISTORY(p.id));
            setHistory(res.data);
        } catch { /* silent */ }
    };

    const selectHistoryVersion = (h: PolicyVersion) => {
        setRules({ ...DEFAULT_RULES, ...h.rules_jsonb });
        setViewingOld(h.id !== selected?.id);
    };

    const saveVersion = async () => {
        if (!selected) return;
        setSaving(true);
        setError('');
        try {
            await api.put(ENDPOINTS.GOV_POLICY(selected.id), { rules_jsonb: rules });
            showToast('Nova versão salva com sucesso!');
            await loadPolicies();
            // reload selected with fresh data
            const res = await api.get(ENDPOINTS.GOV_POLICIES);
            const updated = (res.data as PolicyVersion[]).find(p => p.name === selected.name);
            if (updated) await selectPolicy(updated);
            setViewingOld(false);
        } catch {
            setError('Erro ao salvar nova versão');
        } finally {
            setSaving(false);
        }
    };

    const createPolicy = async () => {
        if (newPolicyName.trim().length < 3) return;
        setCreating(true);
        try {
            await api.post(ENDPOINTS.GOV_POLICIES, { name: newPolicyName.trim(), rules_jsonb: DEFAULT_RULES });
            showToast('Política criada com sucesso!');
            setNewPolicyModal(false);
            setNewPolicyName('');
            await loadPolicies();
        } catch {
            setError('Erro ao criar política');
        } finally {
            setCreating(false);
        }
    };

    const updateRule = <K extends keyof RulesJsonb>(key: K, value: RulesJsonb[K]) => {
        setRules(r => ({ ...r, [key]: value }));
    };

    const compareVersions = async (fromId: string, toId: string) => {
        setDiffLoading(true);
        setDiffResult(null);
        try {
            const res = await api.get(ENDPOINTS.GOV_POLICY_DIFF(fromId, toId));
            setDiffResult(res.data as PolicyDiff);
        } catch {
            setError('Erro ao comparar versões');
        } finally {
            setDiffLoading(false);
        }
    };

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4">

                <PageHeader
                    title="Políticas de Governança"
                    subtitle="Motor OPA — configure regras aplicadas em tempo real"
                    icon={<ShieldCheck className="w-5 h-5" />}
                    actions={
                        <button
                            onClick={() => setNewPolicyModal(true)}
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                            Nova Política
                        </button>
                    }
                />

                {error && (
                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">{error}</div>
                )}

                {toast && (
                    <div className="fixed top-6 right-6 z-50 px-4 py-3 bg-emerald-600 text-white rounded-xl shadow-xl text-sm font-medium animate-in slide-in-from-top-2 duration-300">
                        ✓ {toast}
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">

                    {/* Left panel — policy list + history */}
                    <div className="bg-card border border-border rounded-xl p-4 space-y-4 self-start">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Políticas</div>
                        <div className="space-y-1">
                            {policies.length === 0 && (
                                <p className="text-sm text-muted-foreground py-2">Nenhuma política encontrada.</p>
                            )}
                            {policies.map(p => (
                                <button
                                    key={p.id}
                                    onClick={() => selectPolicy(p)}
                                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                                        selected?.name === p.name
                                            ? 'bg-primary/10 text-primary border border-primary/20'
                                            : 'hover:bg-secondary/50 text-foreground'
                                    }`}
                                >
                                    <div className="font-medium">{p.name}</div>
                                    <div className="text-xs text-muted-foreground mt-0.5">
                                        v{p.version} · {format(new Date(p.created_at), 'dd/MM/yyyy', { locale: ptBR })}
                                    </div>
                                </button>
                            ))}
                        </div>

                        {selected && history.length > 0 && (
                            <div>
                                <button
                                    onClick={() => setHistoryOpen(h => !h)}
                                    className="flex items-center gap-2 w-full text-xs font-semibold text-muted-foreground uppercase tracking-wide py-1 hover:text-foreground transition-colors"
                                >
                                    <History className="w-3.5 h-3.5" />
                                    Histórico
                                    {historyOpen ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
                                </button>
                                {historyOpen && (
                                    <div className="space-y-0.5 mt-1">
                                        {history.map((h, idx) => (
                                            <div key={h.id}>
                                                <button
                                                    onClick={() => selectHistoryVersion(h)}
                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <Clock className="w-3 h-3" />
                                                        <span>v{h.version}</span>
                                                        <span>— {format(new Date(h.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</span>
                                                    </div>
                                                </button>
                                                {idx < history.length - 1 && (
                                                    <button
                                                        onClick={() => {
                                                            setHistoryOpen(true);
                                                            setDiffResult(null);
                                                            compareVersions(history[idx + 1].id, h.id);
                                                        }}
                                                        disabled={diffLoading}
                                                        className="w-full flex items-center justify-center gap-1 py-1 text-[10px] text-primary/60 hover:text-primary hover:bg-secondary/20 rounded transition-colors disabled:opacity-40"
                                                    >
                                                        <GitCompare className="w-3 h-3" />
                                                        Comparar v{history[idx + 1].version} → v{h.version}
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Diff result panel */}
                        {(diffLoading || diffResult) && (
                            <div className="mt-2 rounded-lg border border-border overflow-hidden">
                                <div className="bg-secondary/30 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border flex items-center justify-between">
                                    <span className="flex items-center gap-1.5"><GitCompare className="w-3 h-3" /> Comparação</span>
                                    <button onClick={() => setDiffResult(null)} className="text-muted-foreground hover:text-foreground"><X className="w-3 h-3" /></button>
                                </div>
                                {diffLoading && <div className="p-3 text-xs text-muted-foreground animate-pulse">Calculando diff...</div>}
                                {diffResult && (
                                    <div className="p-2 space-y-1 max-h-64 overflow-y-auto">
                                        {!diffResult.has_changes && (
                                            <p className="text-xs text-muted-foreground p-1">Nenhuma alteração entre as versões.</p>
                                        )}
                                        {diffResult.changes.filter(c => c.type !== 'unchanged').map(change => (
                                            <div key={change.key} className={`rounded p-2 text-xs ${
                                                change.type === 'added'   ? 'bg-success-bg text-success-fg' :
                                                change.type === 'removed' ? 'bg-danger-bg text-danger-fg' :
                                                'bg-warning-bg text-warning-fg'
                                            }`}>
                                                <span className="font-semibold font-mono">{change.key}</span>
                                                {change.type === 'changed' && (
                                                    <div className="mt-0.5 font-mono text-[10px] space-y-0.5">
                                                        <div className="text-danger-fg line-through">{JSON.stringify(change.before)}</div>
                                                        <div className="text-success-fg">{JSON.stringify(change.after)}</div>
                                                    </div>
                                                )}
                                                {change.type === 'added' && (
                                                    <div className="mt-0.5 font-mono text-[10px]">{JSON.stringify(change.after)}</div>
                                                )}
                                                {change.type === 'removed' && (
                                                    <div className="mt-0.5 font-mono text-[10px] line-through">{JSON.stringify(change.before)}</div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Right panel — editor */}
                    {!selected ? (
                        <div className="bg-card border border-border rounded-xl p-8 flex flex-col items-center justify-center text-muted-foreground gap-3">
                            <ShieldCheck className="w-10 h-10 opacity-30" />
                            <p className="text-sm">Selecione uma política para editar</p>
                        </div>
                    ) : (
                        <div className="bg-card border border-border rounded-xl p-6 space-y-5">

                            {/* Header */}
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <h2 className="text-lg font-semibold">{selected.name}</h2>
                                    <div className="text-sm text-muted-foreground">v{selected.version}</div>
                                </div>
                                {viewingOld && (
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-warning-bg border border-warning-border rounded-lg text-warning-fg text-xs font-medium">
                                        <Info className="w-3.5 h-3.5" />
                                        Visualizando versão anterior
                                    </div>
                                )}
                            </div>

                            {/* Forbidden Topics */}
                            <FieldSection
                                title="Tópicos Proibidos"
                                description="Mensagens contendo estes tópicos serão bloqueadas automaticamente pelo motor OPA"
                            >
                                <ChipEditor
                                    items={rules.forbidden_topics}
                                    onChange={v => updateRule('forbidden_topics', v)}
                                    placeholder="Adicionar tópico..."
                                    disabled={viewingOld}
                                />
                            </FieldSection>

                            {/* Controls */}
                            <FieldSection
                                title="Controles de Segurança"
                                description="Configurações de comportamento do motor de governança"
                            >
                                <div className="space-y-4">
                                    {/* PII Filter */}
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-sm font-medium">Filtro de Dados Pessoais (PII)</div>
                                            <div className="text-xs text-muted-foreground">Mascara CPF, email, telefone e dados pessoais antes de enviar ao modelo</div>
                                        </div>
                                        <Toggle checked={rules.pii_filter} onChange={v => updateRule('pii_filter', v)} disabled={viewingOld} />
                                    </div>

                                    {/* Strict Mode */}
                                    <div className={`flex items-center justify-between p-3 rounded-lg transition-colors ${rules.strict_mode ? 'bg-amber-500/5 border border-warning-border' : ''}`}>
                                        <div>
                                            <div className="text-sm font-medium flex items-center gap-2">
                                                Modo Estrito
                                                {rules.strict_mode && <AlertTriangle className="w-3.5 h-3.5 text-warning-fg" />}
                                            </div>
                                            <div className="text-xs text-muted-foreground">Bloqueia a execução em vez de alertar quando uma regra é violada</div>
                                        </div>
                                        <Toggle checked={rules.strict_mode} onChange={v => updateRule('strict_mode', v)} disabled={viewingOld} />
                                    </div>

                                    {/* HITL */}
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-sm font-medium">Aprovação Humana (HITL)</div>
                                            <div className="text-xs text-muted-foreground">Pausa a execução para revisão humana quando keywords sensíveis são detectadas</div>
                                        </div>
                                        <Toggle checked={rules.hitl_enabled} onChange={v => updateRule('hitl_enabled', v)} disabled={viewingOld} />
                                    </div>
                                </div>
                            </FieldSection>

                            {/* HITL Keywords — only when hitl_enabled */}
                            {rules.hitl_enabled && (
                                <FieldSection
                                    title="Keywords HITL"
                                    description="Palavras que acionam a pausa para aprovação humana"
                                >
                                    <ChipEditor
                                        items={rules.hitl_keywords}
                                        onChange={v => updateRule('hitl_keywords', v)}
                                        placeholder="Adicionar keyword..."
                                        disabled={viewingOld}
                                    />
                                </FieldSection>
                            )}

                            {/* Token Limit */}
                            <FieldSection
                                title="Limite de Tokens por Execução"
                                description={`Limita o tamanho máximo da resposta do modelo de IA. Atual: ${rules.max_tokens.toLocaleString()} tokens ≈ ${Math.round(rules.max_tokens * 0.75).toLocaleString()} palavras`}
                            >
                                <div className="space-y-2">
                                    <div className="flex items-center gap-4">
                                        <input
                                            type="range"
                                            min={256}
                                            max={16384}
                                            step={256}
                                            value={rules.max_tokens}
                                            onChange={e => updateRule('max_tokens', Number(e.target.value))}
                                            disabled={viewingOld}
                                            className="flex-1 accent-primary h-2 disabled:opacity-40"
                                        />
                                        <input
                                            type="number"
                                            min={256}
                                            max={16384}
                                            step={256}
                                            value={rules.max_tokens}
                                            onChange={e => updateRule('max_tokens', Math.min(16384, Math.max(256, Number(e.target.value))))}
                                            disabled={viewingOld}
                                            className="w-24 bg-secondary border border-border rounded-md px-3 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-40"
                                        />
                                    </div>
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>256</span><span>4.096</span><span>8.192</span><span>16.384</span>
                                    </div>
                                </div>
                            </FieldSection>

                            {/* JSON Preview */}
                            <div className="border border-border rounded-xl overflow-hidden">
                                <button
                                    onClick={() => setJsonOpen(o => !o)}
                                    className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
                                >
                                    <span>Preview JSON (rules_jsonb)</span>
                                    {jsonOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                </button>
                                {jsonOpen && (
                                    <pre className="px-4 py-3 text-xs font-mono text-muted-foreground bg-background/50 border-t border-border overflow-auto max-h-60">
                                        {JSON.stringify(rules, null, 2)}
                                    </pre>
                                )}
                            </div>

                            {/* Save button */}
                            <div className="flex justify-end pt-2">
                                <button
                                    onClick={saveVersion}
                                    disabled={saving}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                                >
                                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                    {viewingOld ? 'Restaurar Esta Versão' : 'Salvar Nova Versão'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* New Policy Modal */}
            {newPolicyModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/70 backdrop-blur-sm">
                    <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg font-semibold">Nova Política</h3>
                            <button onClick={() => setNewPolicyModal(false)} className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Nome da Política</label>
                            <input
                                autoFocus
                                value={newPolicyName}
                                onChange={e => setNewPolicyName(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && createPolicy()}
                                placeholder="Ex: Política Restritiva Financeiro"
                                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                            <p className="text-xs text-muted-foreground">A política será criada com valores padrão (v1). Você poderá editar as regras em seguida.</p>
                        </div>
                        <div className="flex gap-3 pt-2">
                            <button onClick={() => setNewPolicyModal(false)} className="flex-1 px-4 py-2 bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-sm font-medium transition-colors">
                                Cancelar
                            </button>
                            <button
                                onClick={createPolicy}
                                disabled={creating || newPolicyName.trim().length < 3}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                            >
                                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                Criar
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
