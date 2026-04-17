'use client';

/**
 * Bias Detection page — FASE 13.1
 * ---------------------------------------------------------------------------
 * Lists bias assessments per assistant_version and exposes a modal form to
 * submit a new assessment. Results render with verdict badge + per-metric
 * breakdown. Protected attribute groups are entered row-by-row.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Scale, Plus, RefreshCw, Trash2, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────

interface Assistant {
    id: string;
    name: string;
    status?: string;
}

interface Version {
    id: string;
    version_major: number;
    version_minor: number;
    version_patch: number;
    status: string;
}

interface Assessment {
    id: string;
    assistant_version_id: string;
    test_dataset_name: string;
    test_dataset_size: number;
    protected_attributes: string[];
    demographic_parity: number | null;
    equalized_odds: number | null;
    disparate_impact: number | null;
    statistical_parity: number | null;
    verdict: 'pass' | 'warn' | 'fail';
    group_breakdowns: Record<string, {
        n: number;
        predicted_positive: number;
        positive_rate: number;
        tpr?: number;
        fpr?: number;
    }>;
    raw_results?: { violations?: string[] };
    performed_at: string;
    performed_by_email?: string;
    methodology_notes?: string | null;
}

interface GroupFormRow {
    key: string;
    n: string;
    predicted_positive: string;
    true_positive: string;
    false_positive: string;
    true_negative: string;
    false_negative: string;
}

const emptyGroupRow = (key = ''): GroupFormRow => ({
    key,
    n: '',
    predicted_positive: '',
    true_positive: '',
    false_positive: '',
    true_negative: '',
    false_negative: '',
});

// ── Helpers ───────────────────────────────────────────────────────────────

function verdictBadge(verdict: Assessment['verdict'] | null | undefined) {
    const map: Record<string, { cls: string; label: string; Icon: React.ElementType }> = {
        pass: { cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', label: 'Pass', Icon: CheckCircle2 },
        warn: { cls: 'text-amber-400 bg-amber-400/10 border-amber-400/30', label: 'Warn', Icon: AlertTriangle },
        fail: { cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30', label: 'Fail', Icon: XCircle },
    };
    if (!verdict) {
        return <span className="text-xs text-gray-400 bg-gray-400/10 px-2 py-0.5 rounded-full">—</span>;
    }
    const { cls, label, Icon } = map[verdict];
    return (
        <span className={`text-xs px-2 py-0.5 rounded-full border inline-flex items-center gap-1 ${cls}`}>
            <Icon className="w-3 h-3" />
            {label}
        </span>
    );
}

function formatMetric(v: number | null | undefined, digits = 4): string {
    if (v === null || v === undefined) return '—';
    return Number(v).toFixed(digits);
}

function formatVersion(v: Version): string {
    return `v${v.version_major}.${v.version_minor}.${v.version_patch} (${v.status})`;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function BiasPage() {
    const { orgId } = useAuth();
    const { toast } = useToast();

    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [selectedAssistantId, setSelectedAssistantId] = useState<string>('');
    const [versions, setVersions] = useState<Version[]>([]);
    const [selectedVersionId, setSelectedVersionId] = useState<string>('');
    const [assessments, setAssessments] = useState<Assessment[]>([]);
    const [loading, setLoading] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);

    // ── Load assistants on mount ─────────────────────────────────────────
    const loadAssistants = useCallback(async () => {
        try {
            const res = await api.get(ENDPOINTS.ASSISTANTS);
            const raw: any[] = Array.isArray(res.data) ? res.data : res.data?.assistants || [];
            setAssistants(raw.map((a) => ({ id: a.id, name: a.name, status: a.status })));
        } catch (err) {
            toast('Falha ao listar assistants', 'error');
        }
    }, [toast]);

    useEffect(() => { if (orgId) loadAssistants(); }, [orgId, loadAssistants]);

    // ── Load versions whenever assistant changes ─────────────────────────
    const loadVersions = useCallback(async (assistantId: string) => {
        if (!assistantId) { setVersions([]); setSelectedVersionId(''); return; }
        try {
            const res = await api.get(`/v1/admin/assistants/${assistantId}/versions`);
            const raw: any[] = res.data?.versions || [];
            setVersions(raw.map((v) => ({
                id: v.id,
                version_major: v.version_major ?? 1,
                version_minor: v.version_minor ?? 0,
                version_patch: v.version_patch ?? 0,
                status: v.status ?? 'draft',
            })));
            if (raw.length > 0) setSelectedVersionId(raw[0].id);
            else setSelectedVersionId('');
        } catch {
            setVersions([]);
            setSelectedVersionId('');
        }
    }, []);

    useEffect(() => { loadVersions(selectedAssistantId); }, [selectedAssistantId, loadVersions]);

    // ── Load assessments whenever version changes ────────────────────────
    const loadAssessments = useCallback(async (versionId: string) => {
        if (!versionId) { setAssessments([]); return; }
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.BIAS_BY_VERSION(versionId));
            setAssessments(res.data?.assessments || []);
        } catch {
            setAssessments([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAssessments(selectedVersionId); }, [selectedVersionId, loadAssessments]);

    // ── Derived counts ────────────────────────────────────────────────────
    const verdictCounts = useMemo(() => {
        const counts = { pass: 0, warn: 0, fail: 0 };
        for (const a of assessments) counts[a.verdict]++;
        return counts;
    }, [assessments]);

    return (
        <div className="p-6 max-w-7xl mx-auto">
            <PageHeader
                title="Detecção de Viés (Bias Detection)"
                subtitle="Fairness metrics por versão de assistente — EU AI Act Art. 10 · LGPD Art. 20"
                icon={<Scale className="w-5 h-5" />}
                actions={
                    <div className="flex gap-2">
                        <button
                            onClick={() => loadAssessments(selectedVersionId)}
                            disabled={!selectedVersionId}
                            className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-border bg-secondary/50 hover:bg-secondary text-foreground disabled:opacity-40"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Recarregar
                        </button>
                        <button
                            onClick={() => setModalOpen(true)}
                            disabled={!selectedVersionId}
                            className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                        >
                            <Plus className="w-4 h-4" />
                            Nova Avaliação
                        </button>
                    </div>
                }
            />

            {/* Scope selectors */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
                <div>
                    <label className="text-xs text-muted-foreground block mb-1">Assistant</label>
                    <select
                        value={selectedAssistantId}
                        onChange={(e) => setSelectedAssistantId(e.target.value)}
                        className="w-full bg-secondary/40 border border-border rounded-md px-3 py-2 text-sm"
                    >
                        <option value="">— selecionar —</option>
                        {assistants.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="text-xs text-muted-foreground block mb-1">Versão</label>
                    <select
                        value={selectedVersionId}
                        onChange={(e) => setSelectedVersionId(e.target.value)}
                        disabled={versions.length === 0}
                        className="w-full bg-secondary/40 border border-border rounded-md px-3 py-2 text-sm"
                    >
                        {versions.length === 0 && <option value="">—</option>}
                        {versions.map((v) => (
                            <option key={v.id} value={v.id}>{formatVersion(v)}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Summary cards */}
            {selectedVersionId && (
                <div className="grid grid-cols-3 gap-3 mb-5">
                    <SummaryCard label="Pass" count={verdictCounts.pass} color="emerald" />
                    <SummaryCard label="Warn" count={verdictCounts.warn} color="amber" />
                    <SummaryCard label="Fail" count={verdictCounts.fail} color="rose" />
                </div>
            )}

            {/* Table */}
            <div className="border border-border rounded-xl overflow-hidden bg-card/40">
                <table className="w-full text-sm">
                    <thead className="bg-secondary/40 text-muted-foreground text-xs uppercase tracking-wider">
                        <tr>
                            <th className="text-left p-3 font-medium">Dataset</th>
                            <th className="text-left p-3 font-medium">Veredito</th>
                            <th className="text-right p-3 font-medium">Demographic parity</th>
                            <th className="text-right p-3 font-medium">Equalized odds</th>
                            <th className="text-right p-3 font-medium">Disparate impact</th>
                            <th className="text-right p-3 font-medium">n</th>
                            <th className="text-left p-3 font-medium">Quando</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Carregando…</td></tr>
                        )}
                        {!loading && assessments.length === 0 && (
                            <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">
                                {selectedVersionId
                                    ? 'Nenhuma avaliação ainda para esta versão.'
                                    : 'Selecione um assistant + versão para visualizar avaliações.'}
                            </td></tr>
                        )}
                        {!loading && assessments.map((a) => (
                            <tr key={a.id} className="border-t border-border/50">
                                <td className="p-3">
                                    <div className="font-medium text-foreground">{a.test_dataset_name}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {a.protected_attributes?.join(', ')}
                                    </div>
                                </td>
                                <td className="p-3">{verdictBadge(a.verdict)}</td>
                                <td className="p-3 text-right tabular-nums">{formatMetric(a.demographic_parity)}</td>
                                <td className="p-3 text-right tabular-nums">{formatMetric(a.equalized_odds)}</td>
                                <td className="p-3 text-right tabular-nums">{formatMetric(a.disparate_impact)}</td>
                                <td className="p-3 text-right tabular-nums">{a.test_dataset_size.toLocaleString()}</td>
                                <td className="p-3 text-xs text-muted-foreground">
                                    {new Date(a.performed_at).toLocaleString('pt-BR')}<br />
                                    {a.performed_by_email && <span>por {a.performed_by_email}</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Violations accordion for failed assessments */}
            {assessments.some((a) => a.raw_results?.violations && a.raw_results.violations.length > 0) && (
                <div className="mt-5 space-y-3">
                    <h3 className="text-sm font-semibold text-foreground">Violações de threshold</h3>
                    {assessments
                        .filter((a) => a.raw_results?.violations && a.raw_results.violations.length > 0)
                        .map((a) => (
                            <div key={a.id} className="border border-rose-500/30 bg-rose-500/5 rounded-lg p-3">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm font-medium">{a.test_dataset_name}</span>
                                    {verdictBadge(a.verdict)}
                                </div>
                                <ul className="list-disc list-inside text-xs text-rose-300 space-y-0.5">
                                    {a.raw_results!.violations!.map((v, i) => <li key={i}>{v}</li>)}
                                </ul>
                            </div>
                        ))}
                </div>
            )}

            {/* Modal */}
            {modalOpen && selectedVersionId && (
                <SubmitModal
                    versionId={selectedVersionId}
                    onClose={() => setModalOpen(false)}
                    onSubmitted={() => { setModalOpen(false); loadAssessments(selectedVersionId); }}
                />
            )}
        </div>
    );
}

// ── Summary card ─────────────────────────────────────────────────────────
function SummaryCard({ label, count, color }: { label: string; count: number; color: 'emerald' | 'amber' | 'rose' }) {
    const colorMap: Record<string, string> = {
        emerald: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
        amber: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
        rose: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    };
    return (
        <div className={`border rounded-xl p-4 ${colorMap[color]}`}>
            <div className="text-xs uppercase tracking-wider">{label}</div>
            <div className="text-2xl font-bold mt-1 tabular-nums">{count}</div>
        </div>
    );
}

// ── Submit modal ──────────────────────────────────────────────────────────

function SubmitModal({
    versionId, onClose, onSubmitted,
}: {
    versionId: string;
    onClose: () => void;
    onSubmitted: () => void;
}) {
    const { toast } = useToast();
    const [datasetName, setDatasetName] = useState('');
    const [protectedAttrsRaw, setProtectedAttrsRaw] = useState('gender');
    const [methodologyNotes, setMethodologyNotes] = useState('');
    const [rows, setRows] = useState<GroupFormRow[]>([
        emptyGroupRow('gender=M'),
        emptyGroupRow('gender=F'),
    ]);
    const [thresholdOpen, setThresholdOpen] = useState(false);
    const [thresholds, setThresholds] = useState({
        demographic_parity_max: '0.1',
        equalized_odds_max: '0.1',
        disparate_impact_min: '0.8',
        disparate_impact_max: '1.25',
    });
    const [busy, setBusy] = useState(false);

    const datasetSize = useMemo(
        () => rows.reduce((acc, r) => acc + (parseInt(r.n) || 0), 0),
        [rows],
    );

    const updateRow = (idx: number, patch: Partial<GroupFormRow>) =>
        setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

    const submit = async () => {
        if (!datasetName.trim()) return toast('Informe o nome do dataset', 'error');
        if (rows.length < 2) return toast('Necessário ao menos 2 grupos', 'error');

        const group_breakdowns: Record<string, any> = {};
        for (const r of rows) {
            if (!r.key.trim()) return toast('Cada grupo precisa de uma chave', 'error');
            const n = parseInt(r.n);
            if (!n || n <= 0) return toast(`Grupo '${r.key}' precisa de n > 0`, 'error');
            const pp = parseInt(r.predicted_positive);
            if (isNaN(pp) || pp < 0) return toast(`Grupo '${r.key}' precisa de predicted_positive ≥ 0`, 'error');
            const entry: any = { n, predicted_positive: pp };
            const tp = parseInt(r.true_positive);
            const fp = parseInt(r.false_positive);
            const tn = parseInt(r.true_negative);
            const fn = parseInt(r.false_negative);
            if (!isNaN(tp)) entry.true_positive = tp;
            if (!isNaN(fp)) entry.false_positive = fp;
            if (!isNaN(tn)) entry.true_negative = tn;
            if (!isNaN(fn)) entry.false_negative = fn;
            group_breakdowns[r.key] = entry;
        }

        const payload = {
            assistant_version_id: versionId,
            test_dataset_name: datasetName.trim(),
            test_dataset_size: datasetSize,
            protected_attributes: protectedAttrsRaw
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            group_breakdowns,
            methodology_notes: methodologyNotes.trim() || undefined,
            thresholds: {
                demographic_parity_max: parseFloat(thresholds.demographic_parity_max),
                equalized_odds_max: parseFloat(thresholds.equalized_odds_max),
                disparate_impact_min: parseFloat(thresholds.disparate_impact_min),
                disparate_impact_max: parseFloat(thresholds.disparate_impact_max),
            },
        };

        setBusy(true);
        try {
            const res = await api.post(ENDPOINTS.BIAS_SUBMIT, payload);
            const verdict = res.data?.verdict as 'pass' | 'warn' | 'fail' | undefined;
            toast(
                verdict
                    ? `Avaliação registrada: ${verdict.toUpperCase()}`
                    : 'Avaliação registrada',
                verdict === 'fail' ? 'error' : 'success',
            );
            onSubmitted();
        } catch (err: any) {
            const msg = err?.response?.data?.error || 'Falha ao registrar avaliação';
            toast(msg, 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                <div className="flex items-center justify-between p-5 border-b border-border">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Scale className="w-5 h-5" />
                        Nova Avaliação de Bias
                    </h2>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-5 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1">Nome do dataset</label>
                            <input
                                value={datasetName}
                                onChange={(e) => setDatasetName(e.target.value)}
                                placeholder="Ex: loan_approvals_2026_Q1"
                                className="w-full bg-secondary/40 border border-border rounded-md px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1">
                                Atributos protegidos (separados por vírgula)
                            </label>
                            <input
                                value={protectedAttrsRaw}
                                onChange={(e) => setProtectedAttrsRaw(e.target.value)}
                                placeholder="gender, race, age_group"
                                className="w-full bg-secondary/40 border border-border rounded-md px-3 py-2 text-sm"
                            />
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-xs text-muted-foreground">Grupos (n ≥ 2)</label>
                            <button
                                onClick={() => setRows([...rows, emptyGroupRow()])}
                                className="text-xs text-primary hover:underline"
                            >
                                + adicionar grupo
                            </button>
                        </div>
                        <div className="space-y-2">
                            {rows.map((r, idx) => (
                                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                                    <input
                                        placeholder="key (ex: gender=F)"
                                        value={r.key}
                                        onChange={(e) => updateRow(idx, { key: e.target.value })}
                                        className="col-span-3 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs"
                                    />
                                    <input placeholder="n" value={r.n} onChange={(e) => updateRow(idx, { n: e.target.value })}
                                        className="col-span-1 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs text-right" />
                                    <input placeholder="ŷ=1" value={r.predicted_positive} onChange={(e) => updateRow(idx, { predicted_positive: e.target.value })}
                                        className="col-span-2 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs text-right" />
                                    <input placeholder="TP" value={r.true_positive} onChange={(e) => updateRow(idx, { true_positive: e.target.value })}
                                        className="col-span-1 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs text-right" />
                                    <input placeholder="FP" value={r.false_positive} onChange={(e) => updateRow(idx, { false_positive: e.target.value })}
                                        className="col-span-1 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs text-right" />
                                    <input placeholder="TN" value={r.true_negative} onChange={(e) => updateRow(idx, { true_negative: e.target.value })}
                                        className="col-span-1 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs text-right" />
                                    <input placeholder="FN" value={r.false_negative} onChange={(e) => updateRow(idx, { false_negative: e.target.value })}
                                        className="col-span-1 bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs text-right" />
                                    <button
                                        onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                                        disabled={rows.length <= 2}
                                        className="col-span-2 text-rose-400 hover:text-rose-300 disabled:opacity-30 text-xs flex items-center gap-1 justify-center"
                                    >
                                        <Trash2 className="w-3 h-3" /> remover
                                    </button>
                                </div>
                            ))}
                        </div>
                        <div className="text-xs text-muted-foreground mt-2">
                            Total n: <strong className="text-foreground">{datasetSize.toLocaleString()}</strong>
                            {' '}— TP/FP/TN/FN opcionais (só necessários para equalized_odds)
                        </div>
                    </div>

                    <div>
                        <label className="text-xs text-muted-foreground block mb-1">Notas metodológicas (opcional)</label>
                        <textarea
                            value={methodologyNotes}
                            onChange={(e) => setMethodologyNotes(e.target.value)}
                            rows={2}
                            className="w-full bg-secondary/40 border border-border rounded-md px-3 py-2 text-sm"
                        />
                    </div>

                    <div className="border border-border rounded-lg">
                        <button
                            onClick={() => setThresholdOpen(!thresholdOpen)}
                            className="w-full text-left px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                        >
                            {thresholdOpen ? '▾' : '▸'} Thresholds avançados
                        </button>
                        {thresholdOpen && (
                            <div className="px-3 pb-3 grid grid-cols-2 gap-2 text-xs">
                                {(['demographic_parity_max', 'equalized_odds_max', 'disparate_impact_min', 'disparate_impact_max'] as const).map((k) => (
                                    <label key={k} className="block">
                                        <span className="text-muted-foreground">{k}</span>
                                        <input
                                            value={thresholds[k]}
                                            onChange={(e) => setThresholds({ ...thresholds, [k]: e.target.value })}
                                            className="mt-0.5 w-full bg-secondary/40 border border-border rounded-md px-2 py-1.5"
                                        />
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
                    <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-border hover:bg-secondary/50">
                        Cancelar
                    </button>
                    <button
                        onClick={submit}
                        disabled={busy}
                        className="text-sm px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                    >
                        {busy ? 'Registrando…' : 'Registrar avaliação'}
                    </button>
                </div>
            </div>
        </div>
    );
}
