'use client';

import { useCallback, useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import {
    Shield, Plus, Trash2, Loader2, Save, AlertCircle, CheckCircle2,
    FlaskConical, ToggleLeft, ToggleRight, ChevronDown, ChevronUp, X,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

type DetectorType = 'builtin' | 'regex' | 'keyword_list';
type DlpAction    = 'mask' | 'block' | 'alert';

interface DlpRule {
    id: string;
    name: string;
    detector_type: DetectorType;
    pattern: string | null;
    pattern_config: Record<string, unknown>;
    action: DlpAction;
    applies_to: string[];
    is_active: boolean;
    is_system: boolean;
    created_at: string;
    updated_at: string;
}

interface TestResult {
    sanitized_text: string;
    blocked: boolean;
    block_reason: string | null;
    detections: {
        rule_id: string;
        rule_name: string;
        detector_type: string;
        pattern_matched: string;
        action_taken: DlpAction;
    }[];
    detection_count: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<DlpAction, string> = {
    mask:  'Mascarar',
    block: 'Bloquear',
    alert: 'Alertar',
};

const ACTION_COLORS: Record<DlpAction, string> = {
    mask:  'bg-warning-bg text-warning-fg border-warning-border',
    block: 'bg-danger-bg text-danger-fg border-danger-border',
    alert: 'bg-info-bg text-info-fg border-info-border',
};

const DETECTOR_LABELS: Record<DetectorType, string> = {
    builtin:      'Builtin',
    regex:        'Regex',
    keyword_list: 'Palavras-chave',
};

const BUILTIN_OPTIONS = [
    'CPF', 'CNPJ', 'EMAIL', 'PHONE', 'CREDIT_CARD',
    'BANK_ACCOUNT', 'CEP', 'RG', 'PIX_KEY', 'PERSON',
];

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ title, subtitle, children, action }: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className="bg-card border border-border rounded-xl p-6 mb-6">
            <div className="flex items-start justify-between border-b border-border pb-3 mb-5">
                <div>
                    <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                    {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
                </div>
                {action}
            </div>
            {children}
        </div>
    );
}

// ── Action badge ───────────────────────────────────────────────────────────

function ActionBadge({ action }: { action: DlpAction }) {
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${ACTION_COLORS[action]}`}>
            {ACTION_LABELS[action]}
        </span>
    );
}

// ── Inline action selector ─────────────────────────────────────────────────

function ActionSelect({ value, onChange, disabled }: {
    value: DlpAction;
    onChange: (v: DlpAction) => void;
    disabled?: boolean;
}) {
    return (
        <select
            value={value}
            onChange={e => onChange(e.target.value as DlpAction)}
            disabled={disabled}
            className="bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
        >
            <option value="mask">Mascarar</option>
            <option value="block">Bloquear</option>
            <option value="alert">Alertar</option>
        </select>
    );
}

// ── Add Rule Modal ─────────────────────────────────────────────────────────

function AddRuleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
    const [name, setName]                       = useState('');
    const [detectorType, setDetectorType]       = useState<DetectorType>('builtin');
    const [builtinPattern, setBuiltinPattern]   = useState('CPF');
    const [regexPattern, setRegexPattern]       = useState('');
    const [regexFlags, setRegexFlags]           = useState('gi');
    const [keywords, setKeywords]               = useState('');
    const [action, setAction]                   = useState<DlpAction>('mask');
    const [saving, setSaving]                   = useState(false);
    const [error, setError]                     = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSaving(true);
        try {
            let pattern: string | undefined;
            let pattern_config: Record<string, unknown> = {};

            if (detectorType === 'builtin') {
                pattern = builtinPattern;
            } else if (detectorType === 'regex') {
                pattern = regexPattern;
                pattern_config = { flags: regexFlags };
            } else {
                pattern_config = { keywords: keywords.split(',').map(k => k.trim()).filter(Boolean) };
            }

            await api.post(ENDPOINTS.DLP_RULES, { name, detector_type: detectorType, pattern, pattern_config, action });
            onSaved();
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: string } } };
            setError(e.response?.data?.error || 'Erro ao criar regra.');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all placeholder:text-muted-foreground';

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl">
                <div className="flex items-center justify-between p-5 border-b border-border">
                    <h3 className="text-base font-semibold text-foreground">Nova Regra DLP</h3>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-5 space-y-4">
                    {error && (
                        <div className="p-3 rounded-lg bg-danger-bg border border-danger-border flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-danger-fg shrink-0 mt-0.5" />
                            <p className="text-sm text-danger-fg">{error}</p>
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Nome</label>
                        <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputClass} placeholder="Ex: CPF Corporativo" required />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tipo de Detector</label>
                            <select value={detectorType} onChange={e => setDetectorType(e.target.value as DetectorType)}
                                className={inputClass}>
                                <option value="builtin">Builtin</option>
                                <option value="regex">Regex</option>
                                <option value="keyword_list">Palavras-chave</option>
                            </select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Ação</label>
                            <select value={action} onChange={e => setAction(e.target.value as DlpAction)} className={inputClass}>
                                <option value="mask">Mascarar</option>
                                <option value="block">Bloquear</option>
                                <option value="alert">Alertar</option>
                            </select>
                        </div>
                    </div>

                    {detectorType === 'builtin' && (
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Entidade Builtin</label>
                            <select value={builtinPattern} onChange={e => setBuiltinPattern(e.target.value)} className={inputClass}>
                                {BUILTIN_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                        </div>
                    )}

                    {detectorType === 'regex' && (
                        <div className="space-y-3">
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Padrão Regex</label>
                                <input type="text" value={regexPattern} onChange={e => setRegexPattern(e.target.value)}
                                    className={inputClass} placeholder="\b\d{3}\.\d{3}\.\d{3}-\d{2}\b" required />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Flags</label>
                                <input type="text" value={regexFlags} onChange={e => setRegexFlags(e.target.value)}
                                    className={inputClass} placeholder="gi" />
                            </div>
                        </div>
                    )}

                    {detectorType === 'keyword_list' && (
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                Palavras-chave <span className="font-normal normal-case">(separadas por vírgula)</span>
                            </label>
                            <textarea value={keywords} onChange={e => setKeywords(e.target.value)}
                                className={`${inputClass} resize-none h-20`}
                                placeholder="senha, token, api_key, secret" required />
                        </div>
                    )}

                    <div className="flex gap-3 pt-1">
                        <button type="button" onClick={onClose}
                            className="flex-1 border border-border text-muted-foreground hover:text-foreground text-sm font-medium py-2 rounded-lg transition-colors">
                            Cancelar
                        </button>
                        <button type="submit" disabled={saving}
                            className="flex-1 bg-primary text-primary-foreground text-sm font-semibold py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {saving ? 'Salvando…' : 'Criar Regra'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ── Test Modal ─────────────────────────────────────────────────────────────

function TestModal({ onClose }: { onClose: () => void }) {
    const [text, setText]             = useState('');
    const [testing, setTesting]       = useState(false);
    const [result, setResult]         = useState<TestResult | null>(null);
    const [error, setError]           = useState('');

    const handleTest = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setResult(null);
        setTesting(true);
        try {
            const res = await api.post(ENDPOINTS.DLP_TEST, { text });
            setResult(res.data);
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: string } } };
            setError(e.response?.data?.error || 'Erro ao testar DLP.');
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl">
                <div className="flex items-center justify-between p-5 border-b border-border">
                    <div className="flex items-center gap-2">
                        <FlaskConical className="w-4 h-4 text-primary" />
                        <h3 className="text-base font-semibold text-foreground">Testar DLP</h3>
                    </div>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-5 space-y-4">
                    {error && (
                        <div className="p-3 rounded-lg bg-danger-bg border border-danger-border flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-danger-fg shrink-0 mt-0.5" />
                            <p className="text-sm text-danger-fg">{error}</p>
                        </div>
                    )}

                    <form onSubmit={handleTest} className="space-y-3">
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Texto de Teste</label>
                            <textarea
                                value={text}
                                onChange={e => setText(e.target.value)}
                                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none h-28 placeholder:text-muted-foreground"
                                placeholder="Digite ou cole um texto com dados sensíveis para testar as regras DLP ativas…"
                                required
                            />
                        </div>
                        <button type="submit" disabled={testing || !text.trim()}
                            className="w-full bg-primary text-primary-foreground text-sm font-semibold py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
                            {testing ? 'Processando…' : 'Executar Teste'}
                        </button>
                    </form>

                    {result && (
                        <div className="space-y-3 pt-2 border-t border-border">
                            {/* Status */}
                            <div className={`flex items-center gap-2 p-3 rounded-lg border ${
                                result.blocked
                                    ? 'bg-danger-bg border-danger-border'
                                    : result.detection_count > 0
                                        ? 'bg-warning-bg border-warning-border'
                                        : 'bg-success-bg border-success-border'
                            }`}>
                                {result.blocked
                                    ? <AlertCircle className="w-4 h-4 text-danger-fg shrink-0" />
                                    : result.detection_count > 0
                                        ? <AlertCircle className="w-4 h-4 text-warning-fg shrink-0" />
                                        : <CheckCircle2 className="w-4 h-4 text-success-fg shrink-0" />
                                }
                                <p className={`text-sm font-medium ${
                                    result.blocked ? 'text-danger-fg'
                                    : result.detection_count > 0 ? 'text-warning-fg'
                                    : 'text-success-fg'
                                }`}>
                                    {result.blocked
                                        ? `Mensagem bloqueada — ${result.block_reason}`
                                        : result.detection_count > 0
                                            ? `${result.detection_count} detecção(ões) encontrada(s)`
                                            : 'Nenhuma detecção — texto aprovado'
                                    }
                                </p>
                            </div>

                            {/* Sanitized text */}
                            {!result.blocked && (
                                <div className="space-y-1">
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Texto Sanitizado</p>
                                    <pre className="bg-secondary border border-border rounded-lg p-3 text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                                        {result.sanitized_text}
                                    </pre>
                                </div>
                            )}

                            {/* Detections table */}
                            {result.detections.length > 0 && (
                                <div className="space-y-1">
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Detecções</p>
                                    <div className="overflow-x-auto rounded-lg border border-border">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="border-b border-border bg-secondary/50">
                                                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Regra</th>
                                                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Correspondência</th>
                                                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Ação</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {result.detections.map((d, i) => (
                                                    <tr key={i} className="border-b border-border last:border-0">
                                                        <td className="px-3 py-2 text-foreground font-medium">{d.rule_name}</td>
                                                        <td className="px-3 py-2 text-muted-foreground font-mono">{d.pattern_matched}</td>
                                                        <td className="px-3 py-2"><ActionBadge action={d.action_taken} /></td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex justify-end pt-1">
                        <button type="button" onClick={onClose}
                            className="border border-border text-muted-foreground hover:text-foreground text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                            Fechar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Delete confirm ─────────────────────────────────────────────────────────

function DeleteConfirm({ rule, onClose, onDeleted }: {
    rule: DlpRule;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const [deleting, setDeleting] = useState(false);
    const [error, setError]       = useState('');

    const handleDelete = async () => {
        setDeleting(true);
        try {
            await api.delete(ENDPOINTS.DLP_RULE(rule.id));
            onDeleted();
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: string } } };
            setError(e.response?.data?.error || 'Erro ao excluir regra.');
            setDeleting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl p-6">
                <h3 className="text-base font-semibold text-foreground mb-2">Excluir Regra</h3>
                <p className="text-sm text-muted-foreground mb-4">
                    Tem certeza que deseja excluir a regra <span className="font-medium text-foreground">"{rule.name}"</span>? Esta ação não pode ser desfeita.
                </p>
                {error && <p className="text-sm text-danger-fg mb-3">{error}</p>}
                <div className="flex gap-3">
                    <button onClick={onClose} className="flex-1 border border-border text-muted-foreground hover:text-foreground text-sm font-medium py-2 rounded-lg transition-colors">
                        Cancelar
                    </button>
                    <button onClick={handleDelete} disabled={deleting}
                        className="flex-1 bg-rose-600 text-white text-sm font-semibold py-2 rounded-lg hover:bg-rose-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                        {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                        {deleting ? 'Excluindo…' : 'Excluir'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function DlpPage() {
    const { role } = useAuth();
    const isAdmin = role === 'admin';

    const [rules, setRules]                     = useState<DlpRule[]>([]);
    const [loading, setLoading]                 = useState(true);
    const [savingId, setSavingId]               = useState<string | null>(null);
    const [pendingAction, setPendingAction]     = useState<Record<string, DlpAction>>({});
    const [successId, setSuccessId]             = useState<string | null>(null);
    const [showAddModal, setShowAddModal]       = useState(false);
    const [showTestModal, setShowTestModal]     = useState(false);
    const [deleteTarget, setDeleteTarget]       = useState<DlpRule | null>(null);
    const [expandedId, setExpandedId]           = useState<string | null>(null);
    const [globalError, setGlobalError]         = useState('');

    const loadRules = useCallback(async () => {
        try {
            const res = await api.get(ENDPOINTS.DLP_RULES);
            setRules(res.data);
        } catch {
            setGlobalError('Erro ao carregar regras DLP.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadRules(); }, [loadRules]);

    const handleToggleActive = async (rule: DlpRule) => {
        if (!isAdmin) return;
        setSavingId(rule.id);
        try {
            await api.put(ENDPOINTS.DLP_RULE(rule.id), { is_active: !rule.is_active });
            setRules(prev => prev.map(r => r.id === rule.id ? { ...r, is_active: !r.is_active } : r));
        } catch {
            setGlobalError('Erro ao atualizar regra.');
        } finally {
            setSavingId(null);
        }
    };

    const handleActionChange = (ruleId: string, action: DlpAction) => {
        setPendingAction(prev => ({ ...prev, [ruleId]: action }));
    };

    const handleSaveAction = async (rule: DlpRule) => {
        const newAction = pendingAction[rule.id];
        if (!newAction || newAction === rule.action) return;
        setSavingId(rule.id);
        try {
            await api.put(ENDPOINTS.DLP_RULE(rule.id), { action: newAction });
            setRules(prev => prev.map(r => r.id === rule.id ? { ...r, action: newAction } : r));
            setPendingAction(prev => { const n = { ...prev }; delete n[rule.id]; return n; });
            setSuccessId(rule.id);
            setTimeout(() => setSuccessId(null), 2000);
        } catch {
            setGlobalError('Erro ao salvar ação.');
        } finally {
            setSavingId(null);
        }
    };

    const systemRules = rules.filter(r => r.is_system);
    const customRules = rules.filter(r => !r.is_system);

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto p-4 sm:p-6">
            <PageHeader
                icon={<Shield className="w-5 h-5 text-primary" />}
                title="Proteção de Dados (DLP)"
                subtitle="Configure regras de detecção e prevenção de dados sensíveis por organização."
                actions={
                    <div className="flex gap-2">
                        <button
                            onClick={() => setShowTestModal(true)}
                            className="flex items-center gap-2 border border-border text-foreground text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary transition-colors"
                        >
                            <FlaskConical className="w-4 h-4" />
                            Testar DLP
                        </button>
                        {isAdmin && (
                            <button
                                onClick={() => setShowAddModal(true)}
                                className="flex items-center gap-2 bg-primary text-primary-foreground text-sm font-semibold px-3 py-2 rounded-lg hover:bg-primary/90 transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                                Nova Regra
                            </button>
                        )}
                    </div>
                }
            />

            {globalError && (
                <div className="mb-4 p-3 rounded-lg bg-danger-bg border border-danger-border flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-danger-fg shrink-0 mt-0.5" />
                    <p className="text-sm text-danger-fg">{globalError}</p>
                </div>
            )}

            {/* ── System Rules ─────────────────────────────────────────── */}
            <Section
                title="Regras de Sistema"
                subtitle="Detectores integrados. Apenas ação, status ativo e escopo podem ser alterados."
            >
                {systemRules.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">Nenhuma regra de sistema.</p>
                ) : (
                    <div className="space-y-2">
                        {systemRules.map(rule => (
                            <RuleRow
                                key={rule.id}
                                rule={rule}
                                isAdmin={isAdmin}
                                savingId={savingId}
                                successId={successId}
                                pendingAction={pendingAction}
                                expandedId={expandedId}
                                onToggleExpand={(id) => setExpandedId(prev => prev === id ? null : id)}
                                onToggleActive={handleToggleActive}
                                onActionChange={handleActionChange}
                                onSaveAction={handleSaveAction}
                                onDeleteClick={() => {}} // system rules cannot be deleted
                                showDelete={false}
                            />
                        ))}
                    </div>
                )}
            </Section>

            {/* ── Custom Rules ─────────────────────────────────────────── */}
            <Section
                title="Regras Personalizadas"
                subtitle="Regras customizadas por regex ou lista de palavras-chave."
                action={isAdmin ? (
                    <button onClick={() => setShowAddModal(true)}
                        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium transition-colors">
                        <Plus className="w-3.5 h-3.5" /> Adicionar
                    </button>
                ) : undefined}
            >
                {customRules.length === 0 ? (
                    <div className="text-center py-8">
                        <Shield className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">Nenhuma regra personalizada.</p>
                        {isAdmin && (
                            <button onClick={() => setShowAddModal(true)}
                                className="mt-3 text-sm text-primary hover:text-primary/80 font-medium transition-colors">
                                Criar primeira regra
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="space-y-2">
                        {customRules.map(rule => (
                            <RuleRow
                                key={rule.id}
                                rule={rule}
                                isAdmin={isAdmin}
                                savingId={savingId}
                                successId={successId}
                                pendingAction={pendingAction}
                                expandedId={expandedId}
                                onToggleExpand={(id) => setExpandedId(prev => prev === id ? null : id)}
                                onToggleActive={handleToggleActive}
                                onActionChange={handleActionChange}
                                onSaveAction={handleSaveAction}
                                onDeleteClick={(r) => setDeleteTarget(r)}
                                showDelete={true}
                            />
                        ))}
                    </div>
                )}
            </Section>

            {/* Modals */}
            {showAddModal && (
                <AddRuleModal
                    onClose={() => setShowAddModal(false)}
                    onSaved={() => { setShowAddModal(false); loadRules(); }}
                />
            )}
            {showTestModal && <TestModal onClose={() => setShowTestModal(false)} />}
            {deleteTarget && (
                <DeleteConfirm
                    rule={deleteTarget}
                    onClose={() => setDeleteTarget(null)}
                    onDeleted={() => { setDeleteTarget(null); loadRules(); }}
                />
            )}
        </div>
        </div>
    );
}

// ── Rule Row ───────────────────────────────────────────────────────────────

function RuleRow({
    rule, isAdmin, savingId, successId, pendingAction, expandedId,
    onToggleExpand, onToggleActive, onActionChange, onSaveAction, onDeleteClick, showDelete,
}: {
    rule: DlpRule;
    isAdmin: boolean;
    savingId: string | null;
    successId: string | null;
    pendingAction: Record<string, DlpAction>;
    expandedId: string | null;
    onToggleExpand: (id: string) => void;
    onToggleActive: (rule: DlpRule) => void;
    onActionChange: (ruleId: string, action: DlpAction) => void;
    onSaveAction: (rule: DlpRule) => void;
    onDeleteClick: (rule: DlpRule) => void;
    showDelete: boolean;
}) {
    const isExpanded = expandedId === rule.id;
    const isSaving   = savingId === rule.id;
    const isSuccess  = successId === rule.id;
    const pending    = pendingAction[rule.id];
    const hasPending = pending && pending !== rule.action;

    return (
        <div className={`border rounded-xl transition-all ${rule.is_active ? 'border-border' : 'border-border/40 opacity-60'}`}>
            {/* Main row */}
            <div className="flex items-center gap-3 px-4 py-3">
                {/* Toggle active */}
                {isAdmin ? (
                    <button onClick={() => onToggleActive(rule)} disabled={isSaving}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
                        {isSaving
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : rule.is_active
                                ? <ToggleRight className="w-5 h-5 text-primary" />
                                : <ToggleLeft className="w-5 h-5" />
                        }
                    </button>
                ) : (
                    <div className={`w-2 h-2 rounded-full shrink-0 ${rule.is_active ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                )}

                {/* Name + badges */}
                <div className="flex-1 flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{rule.name}</span>
                    <span className="text-xs text-muted-foreground bg-secondary border border-border rounded px-1.5 py-0.5 shrink-0">
                        {DETECTOR_LABELS[rule.detector_type]}
                    </span>
                    {rule.is_system && (
                        <span className="text-xs text-muted-foreground/60 bg-secondary/50 border border-border/50 rounded px-1.5 py-0.5 shrink-0">
                            sistema
                        </span>
                    )}
                </div>

                {/* Inline action editor */}
                {isAdmin ? (
                    <div className="flex items-center gap-2 shrink-0">
                        <ActionSelect
                            value={(pending as DlpAction) ?? rule.action}
                            onChange={(v) => onActionChange(rule.id, v)}
                            disabled={isSaving}
                        />
                        {hasPending && (
                            <button onClick={() => onSaveAction(rule)} disabled={isSaving}
                                className="flex items-center gap-1 text-xs bg-primary text-primary-foreground px-2 py-1 rounded hover:bg-primary/90 disabled:opacity-50 transition-colors">
                                {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                                Salvar
                            </button>
                        )}
                        {isSuccess && !hasPending && (
                            <CheckCircle2 className="w-4 h-4 text-success-fg shrink-0" />
                        )}
                        {!hasPending && !isSuccess && <ActionBadge action={rule.action} />}
                    </div>
                ) : (
                    <ActionBadge action={rule.action} />
                )}

                {/* Delete */}
                {showDelete && isAdmin && (
                    <button onClick={() => onDeleteClick(rule)}
                        className="text-muted-foreground hover:text-danger-fg transition-colors shrink-0">
                        <Trash2 className="w-4 h-4" />
                    </button>
                )}

                {/* Expand */}
                <button onClick={() => onToggleExpand(rule.id)}
                    className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
            </div>

            {/* Expanded details */}
            {isExpanded && (
                <div className="border-t border-border px-4 py-3 bg-secondary/30 rounded-b-xl space-y-2">
                    {rule.pattern && (
                        <div className="flex gap-2">
                            <span className="text-xs text-muted-foreground font-medium w-24 shrink-0">Padrão:</span>
                            <code className="text-xs text-foreground font-mono bg-secondary border border-border rounded px-1.5 py-0.5 break-all">
                                {rule.pattern}
                            </code>
                        </div>
                    )}
                    {rule.detector_type === 'keyword_list' && (
                        <div className="flex gap-2">
                            <span className="text-xs text-muted-foreground font-medium w-24 shrink-0">Palavras:</span>
                            <span className="text-xs text-foreground">
                                {((rule.pattern_config?.keywords as string[]) || []).join(', ')}
                            </span>
                        </div>
                    )}
                    {rule.applies_to.length > 0 && (
                        <div className="flex gap-2">
                            <span className="text-xs text-muted-foreground font-medium w-24 shrink-0">Escopo:</span>
                            <span className="text-xs text-foreground">{rule.applies_to.join(', ')}</span>
                        </div>
                    )}
                    {rule.applies_to.length === 0 && (
                        <div className="flex gap-2">
                            <span className="text-xs text-muted-foreground font-medium w-24 shrink-0">Escopo:</span>
                            <span className="text-xs text-muted-foreground italic">Todos os assistentes</span>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <span className="text-xs text-muted-foreground font-medium w-24 shrink-0">Atualizado:</span>
                        <span className="text-xs text-muted-foreground">
                            {new Date(rule.updated_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
