'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    BrainCircuit, Plus, RefreshCw, ChevronRight,
    ClipboardList, Search, CheckCircle2, GitBranch,
    X, FileText, MessageSquare, Layers,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';

// ── Types ──────────────────────────────────────────────────────────────────

interface DemandCase {
    id: string;
    title: string;
    description: string | null;
    source_type: string;
    status: string;
    priority: string;
    created_at: string;
    updated_at: string;
}

interface ProblemContract {
    id: string;
    goal: string;
    confidence_score: number;
    status: string;
    open_questions_json: Array<{ question: string; answered: boolean; answer: string | null }>;
    acceptance_criteria_json: unknown[];
    constraints_json: unknown[];
    non_goals_json: unknown[];
    created_at: string;
}

interface DecisionSet {
    id: string;
    recommended_option: string;
    status: string;
    rationale_md: string;
    risks_json: unknown[];
    alternatives_json: unknown[];
    tradeoffs_json: unknown[];
    created_at: string;
}

interface WorkflowGraph {
    id: string;
    status: string;
    created_at: string;
}

interface WorkItem {
    id: string;
    title: string;
    item_type: string;
    status: string;
    node_id: string;
}

interface DemandCaseFull {
    case: DemandCase;
    contract: ProblemContract | null;
    decisions: DecisionSet[];
    workflow: WorkflowGraph | null;
    workItems: WorkItem[];
}

interface DiscoveryStatus {
    caseStatus: string;
    contractExists: boolean;
    contractStatus: string | null;
    confidenceScore: number;
    totalQuestions: number;
    answeredQuestions: number;
    readyForAcceptance: boolean;
    hasAcceptanceCriteria: boolean;
}

// ── Color helpers ──────────────────────────────────────────────────────────

function statusBadge(s: string) {
    switch (s) {
        case 'draft':      return 'text-gray-400 bg-gray-500/10 border-gray-500/20';
        case 'intake':     return 'text-blue-400 bg-blue-500/10 border-blue-500/20';
        case 'discovery':  return 'text-violet-400 bg-violet-500/10 border-violet-500/20';
        case 'design':     return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'delegated':  return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'closed':     return 'text-gray-500 bg-gray-500/5 border-gray-500/10';
        case 'approved':   return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'proposed':   return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'rejected':   return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'accepted':   return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        default:           return 'text-gray-400 bg-gray-500/10 border-gray-500/20';
    }
}

function priorityBadge(p: string) {
    switch (p) {
        case 'critical': return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'high':     return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'medium':   return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'low':      return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
        default:         return 'text-gray-400 bg-gray-500/10 border-gray-500/20';
    }
}

function confidenceColor(score: number) {
    if (score >= 70) return 'text-emerald-400';
    if (score >= 40) return 'text-amber-400';
    return 'text-rose-400';
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ArchitectPage() {
    const { role } = useAuth();
    const { toast: showToast } = useToast();

    const [cases, setCases] = useState<DemandCase[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);

    // New case modal
    const [showNewCase, setShowNewCase] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newSourceType, setNewSourceType] = useState('internal');
    const [newPriority, setNewPriority] = useState('medium');
    const [creating, setCreating] = useState(false);

    // Side drawer
    const [selected, setSelected] = useState<DemandCaseFull | null>(null);
    const [drawerTab, setDrawerTab] = useState<'demand' | 'discovery' | 'decision'>('demand');
    const [drawerLoading, setDrawerLoading] = useState(false);

    // Discovery status
    const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus | null>(null);

    // New question
    const [newQuestion, setNewQuestion] = useState('');
    const [addingQuestion, setAddingQuestion] = useState(false);

    // Answer question
    const [answerIdx, setAnswerIdx] = useState<number | null>(null);
    const [answerText, setAnswerText] = useState('');
    const [answering, setAnswering] = useState(false);

    // Document generation
    const [generatingDoc, setGeneratingDoc] = useState(false);
    const [generatedDoc, setGeneratedDoc] = useState<string | null>(null);

    const loadCases = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.ARCHITECT_CASES);
            setCases(res.data.cases ?? []);
            setTotal(res.data.total ?? 0);
        } catch {
            showToast('Erro ao carregar casos', 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { loadCases(); }, [loadCases]);

    const openCase = useCallback(async (caseId: string) => {
        setDrawerLoading(true);
        setSelected(null);
        setDiscoveryStatus(null);
        setGeneratedDoc(null);
        try {
            const [fullRes, statusRes] = await Promise.all([
                api.get(ENDPOINTS.ARCHITECT_CASE(caseId)),
                api.get(ENDPOINTS.ARCHITECT_CASE_DISCOVER_STATUS(caseId)).catch(() => null),
            ]);
            setSelected(fullRes.data);
            if (statusRes) setDiscoveryStatus(statusRes.data);
        } catch {
            showToast('Erro ao carregar detalhes', 'error');
        } finally {
            setDrawerLoading(false);
        }
    }, [showToast]);

    const createCase = async () => {
        if (!newTitle.trim()) return;
        setCreating(true);
        try {
            await api.post(ENDPOINTS.ARCHITECT_CASES, {
                title: newTitle.trim(),
                description: newDesc.trim() || null,
                source_type: newSourceType,
                priority: newPriority,
            });
            showToast('Caso criado com sucesso', 'success');
            setShowNewCase(false);
            setNewTitle('');
            setNewDesc('');
            loadCases();
        } catch {
            showToast('Erro ao criar caso', 'error');
        } finally {
            setCreating(false);
        }
    };

    const advanceStatus = async (caseId: string, status: string) => {
        try {
            await api.patch(ENDPOINTS.ARCHITECT_CASE_STATUS(caseId), { status });
            showToast(`Status atualizado para "${status}"`, 'success');
            loadCases();
            if (selected?.case.id === caseId) openCase(caseId);
        } catch {
            showToast('Erro ao atualizar status', 'error');
        }
    };

    const handleAddQuestion = async () => {
        if (!selected || !newQuestion.trim()) return;
        setAddingQuestion(true);
        try {
            await api.post(ENDPOINTS.ARCHITECT_CASE_DISCOVER_QUESTIONS(selected.case.id), {
                question: newQuestion.trim(),
            });
            showToast('Pergunta adicionada', 'success');
            setNewQuestion('');
            openCase(selected.case.id);
        } catch {
            showToast('Erro ao adicionar pergunta', 'error');
        } finally {
            setAddingQuestion(false);
        }
    };

    const handleAnswerQuestion = async (idx: number) => {
        if (!selected || !answerText.trim()) return;
        setAnswering(true);
        try {
            await api.post(ENDPOINTS.ARCHITECT_CASE_DISCOVER_ANSWER(selected.case.id), {
                questionIndex: idx,
                answer: answerText.trim(),
            });
            showToast('Resposta salva', 'success');
            setAnswerIdx(null);
            setAnswerText('');
            openCase(selected.case.id);
        } catch {
            showToast('Erro ao salvar resposta', 'error');
        } finally {
            setAnswering(false);
        }
    };

    const handleAcceptContract = async () => {
        if (!selected) return;
        try {
            await api.post(ENDPOINTS.ARCHITECT_CASE_CONTRACT_ACCEPT(selected.case.id), {});
            showToast('Contrato aceito', 'success');
            openCase(selected.case.id);
        } catch {
            showToast('Erro ao aceitar contrato', 'error');
        }
    };

    const handleGenerateDocument = async (decisionId: string) => {
        setGeneratingDoc(true);
        setGeneratedDoc(null);
        try {
            const res = await api.post(ENDPOINTS.ARCHITECT_DECISION_DOCUMENT(decisionId), {});
            setGeneratedDoc(res.data.content);
            showToast('Documento gerado com sucesso', 'success');
        } catch {
            showToast('Erro ao gerar documento', 'error');
        } finally {
            setGeneratingDoc(false);
        }
    };

    // ── Stats ────────────────────────────────────────────────────────────────

    const activeCases   = cases.filter(c => !['closed', 'draft'].includes(c.status)).length;
    const discoveryCases = cases.filter(c => c.status === 'discovery').length;
    const designCases   = cases.filter(c => c.status === 'design').length;
    const delegatedCases = cases.filter(c => c.status === 'delegated').length;

    return (
        <div className="flex flex-col h-full overflow-hidden">

            {/* Header */}
            <div className="flex items-center justify-between px-8 py-5 border-b border-border/50 bg-background/30 backdrop-blur-sm shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                        <BrainCircuit className="w-5 h-5 text-violet-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-foreground">Arquiteto de IA</h1>
                        <p className="text-xs text-muted-foreground">Gestão de demandas, decisões e fluxos de implantação</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={loadCases}
                        className="p-2 rounded-lg hover:bg-secondary/40 text-muted-foreground hover:text-foreground transition-colors"
                        title="Recarregar"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    {['admin', 'operator'].includes(role) && (
                        <button
                            onClick={() => setShowNewCase(true)}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                            Nova Demanda
                        </button>
                    )}
                </div>
            </div>

            {/* Section A: Status bar */}
            <div className="grid grid-cols-4 gap-4 px-8 py-4 border-b border-border/30 shrink-0">
                {[
                    { label: 'Casos Ativos', value: activeCases, icon: ClipboardList, color: 'text-violet-400' },
                    { label: 'Em Discovery', value: discoveryCases, icon: Search, color: 'text-blue-400' },
                    { label: 'Aguardando Decisão', value: designCases, icon: Layers, color: 'text-amber-400' },
                    { label: 'Delegados', value: delegatedCases, icon: CheckCircle2, color: 'text-emerald-400' },
                ].map(stat => (
                    <div key={stat.label} className="rounded-xl border border-border/40 bg-card/50 p-4 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-secondary/40 flex items-center justify-center shrink-0">
                            <stat.icon className={`w-5 h-5 ${stat.color}`} />
                        </div>
                        <div>
                            <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
                            <div className="text-xs text-muted-foreground">{stat.label}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Section B: Cases table + drawer */}
            <div className="flex flex-1 overflow-hidden">

                {/* Table */}
                <div className="flex-1 overflow-auto px-8 py-4">
                    {loading && cases.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                            Carregando...
                        </div>
                    ) : cases.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3">
                            <BrainCircuit className="w-10 h-10 text-muted-foreground/30" />
                            <p className="text-sm">Nenhuma demanda encontrada. Crie a primeira.</p>
                        </div>
                    ) : (
                        <div className="rounded-xl border border-border/40 overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-secondary/20 border-b border-border/40">
                                    <tr>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Título</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Prioridade</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tipo</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Criado em</th>
                                        <th className="px-4 py-3" />
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border/20">
                                    {cases.map(c => (
                                        <tr
                                            key={c.id}
                                            onClick={() => { setDrawerTab('demand'); openCase(c.id); }}
                                            className={`hover:bg-secondary/20 cursor-pointer transition-colors ${selected?.case.id === c.id ? 'bg-violet-500/5' : ''}`}
                                        >
                                            <td className="px-4 py-3 font-medium text-foreground">{c.title}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${statusBadge(c.status)}`}>
                                                    {c.status}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${priorityBadge(c.priority)}`}>
                                                    {c.priority}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">{c.source_type}</td>
                                            <td className="px-4 py-3 text-muted-foreground text-xs">
                                                {new Date(c.created_at).toLocaleDateString('pt-BR')}
                                            </td>
                                            <td className="px-4 py-3">
                                                <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className="px-4 py-2 border-t border-border/20 bg-secondary/10 text-xs text-muted-foreground">
                                {total} caso{total !== 1 ? 's' : ''} no total
                            </div>
                        </div>
                    )}
                </div>

                {/* Side drawer */}
                {selected !== null && (
                    <div className="w-[480px] border-l border-border/50 bg-card/40 flex flex-col overflow-hidden shrink-0">
                        {/* Drawer header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-foreground truncate">{selected.case.title}</p>
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border mt-1 ${statusBadge(selected.case.status)}`}>
                                    {selected.case.status}
                                </span>
                            </div>
                            <button
                                onClick={() => setSelected(null)}
                                className="ml-3 p-1.5 rounded-lg hover:bg-secondary/40 text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Tabs */}
                        <div className="flex border-b border-border/40 px-2 shrink-0">
                            {[
                                { id: 'demand', label: 'Demanda', icon: ClipboardList },
                                { id: 'discovery', label: 'Discovery', icon: Search },
                                { id: 'decision', label: 'Decisão', icon: GitBranch },
                            ].map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setDrawerTab(tab.id as typeof drawerTab)}
                                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                                        drawerTab === tab.id
                                            ? 'border-violet-500 text-violet-400'
                                            : 'border-transparent text-muted-foreground hover:text-foreground'
                                    }`}
                                >
                                    <tab.icon className="w-3.5 h-3.5" />
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Drawer body */}
                        {drawerLoading ? (
                            <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
                                Carregando...
                            </div>
                        ) : (
                            <div className="flex-1 overflow-y-auto p-5 space-y-4">

                                {/* ── TAB: Demanda ── */}
                                {drawerTab === 'demand' && (
                                    <div className="space-y-4">
                                        <div className="space-y-1">
                                            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Descrição</p>
                                            <p className="text-sm text-foreground">{selected.case.description ?? '—'}</p>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Prioridade</p>
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${priorityBadge(selected.case.priority)}`}>
                                                    {selected.case.priority}
                                                </span>
                                            </div>
                                            <div>
                                                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Origem</p>
                                                <p className="text-sm text-foreground">{selected.case.source_type}</p>
                                            </div>
                                        </div>

                                        {/* Status actions */}
                                        {['admin', 'operator'].includes(role) && (
                                            <div>
                                                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-2">Avançar Status</p>
                                                <div className="flex flex-wrap gap-2">
                                                    {['intake', 'discovery', 'design', 'delegated', 'closed'].map(s => (
                                                        <button
                                                            key={s}
                                                            onClick={() => advanceStatus(selected.case.id, s)}
                                                            disabled={selected.case.status === s}
                                                            className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                                                                selected.case.status === s
                                                                    ? `${statusBadge(s)} opacity-50 cursor-default`
                                                                    : 'border-border/40 text-muted-foreground hover:text-foreground hover:bg-secondary/40'
                                                            }`}
                                                        >
                                                            {s}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* ── TAB: Discovery ── */}
                                {drawerTab === 'discovery' && (
                                    <div className="space-y-4">
                                        {/* Confidence score */}
                                        {discoveryStatus && (
                                            <div className="rounded-lg border border-border/40 bg-secondary/10 p-4">
                                                <div className="flex items-center justify-between mb-2">
                                                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Confidence Score</span>
                                                    <span className={`text-xl font-bold ${confidenceColor(discoveryStatus.confidenceScore)}`}>
                                                        {discoveryStatus.confidenceScore}%
                                                    </span>
                                                </div>
                                                <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full transition-all ${
                                                            discoveryStatus.confidenceScore >= 70 ? 'bg-emerald-500' :
                                                            discoveryStatus.confidenceScore >= 40 ? 'bg-amber-500' : 'bg-rose-500'
                                                        }`}
                                                        style={{ width: `${discoveryStatus.confidenceScore}%` }}
                                                    />
                                                </div>
                                                <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                                                    <span>{discoveryStatus.answeredQuestions}/{discoveryStatus.totalQuestions} perguntas respondidas</span>
                                                    {discoveryStatus.readyForAcceptance && (
                                                        <span className="text-emerald-400 font-medium">Pronto para aceite</span>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* Contract */}
                                        {selected.contract ? (
                                            <div className="space-y-3">
                                                <div>
                                                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Objetivo</p>
                                                    <p className="text-sm text-foreground">{selected.contract.goal}</p>
                                                </div>
                                                <div className="flex items-center justify-between">
                                                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${statusBadge(selected.contract.status)}`}>
                                                        {selected.contract.status}
                                                    </span>
                                                    {selected.contract.status !== 'accepted' && discoveryStatus?.readyForAcceptance && (
                                                        <button
                                                            onClick={handleAcceptContract}
                                                            className="px-3 py-1 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                                                        >
                                                            Aceitar Contrato
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">Nenhum contrato de problema criado ainda.</p>
                                        )}

                                        {/* Questions */}
                                        {selected.contract && (
                                            <div className="space-y-2">
                                                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Perguntas Abertas</p>
                                                {selected.contract.open_questions_json.length === 0 ? (
                                                    <p className="text-xs text-muted-foreground">Nenhuma pergunta registrada.</p>
                                                ) : (
                                                    <div className="space-y-2">
                                                        {selected.contract.open_questions_json.map((q, i) => (
                                                            <div key={i} className="rounded-lg border border-border/30 bg-secondary/10 p-3">
                                                                <div className="flex items-start gap-2">
                                                                    <MessageSquare className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${q.answered ? 'text-emerald-400' : 'text-muted-foreground'}`} />
                                                                    <div className="flex-1 min-w-0">
                                                                        <p className="text-xs text-foreground">{q.question}</p>
                                                                        {q.answered && q.answer && (
                                                                            <p className="text-xs text-emerald-400 mt-1">{q.answer}</p>
                                                                        )}
                                                                        {!q.answered && answerIdx === i ? (
                                                                            <div className="mt-2 space-y-1.5">
                                                                                <textarea
                                                                                    value={answerText}
                                                                                    onChange={e => setAnswerText(e.target.value)}
                                                                                    rows={2}
                                                                                    placeholder="Resposta..."
                                                                                    className="w-full px-2 py-1.5 rounded bg-background border border-border/50 text-xs text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                                                />
                                                                                <div className="flex gap-1.5">
                                                                                    <button
                                                                                        onClick={() => handleAnswerQuestion(i)}
                                                                                        disabled={answering}
                                                                                        className="px-2 py-1 rounded text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
                                                                                    >
                                                                                        {answering ? '...' : 'Salvar'}
                                                                                    </button>
                                                                                    <button
                                                                                        onClick={() => { setAnswerIdx(null); setAnswerText(''); }}
                                                                                        className="px-2 py-1 rounded text-xs font-medium border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
                                                                                    >
                                                                                        Cancelar
                                                                                    </button>
                                                                                </div>
                                                                            </div>
                                                                        ) : !q.answered && (
                                                                            <button
                                                                                onClick={() => { setAnswerIdx(i); setAnswerText(''); }}
                                                                                className="mt-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
                                                                            >
                                                                                Responder
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Add question */}
                                                {selected.contract.status !== 'accepted' && (
                                                    <div className="flex gap-2 mt-2">
                                                        <input
                                                            type="text"
                                                            value={newQuestion}
                                                            onChange={e => setNewQuestion(e.target.value)}
                                                            placeholder="Nova pergunta..."
                                                            className="flex-1 px-3 py-1.5 rounded-lg bg-background border border-border/50 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                            onKeyDown={e => e.key === 'Enter' && handleAddQuestion()}
                                                        />
                                                        <button
                                                            onClick={handleAddQuestion}
                                                            disabled={addingQuestion || !newQuestion.trim()}
                                                            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
                                                        >
                                                            {addingQuestion ? '...' : <Plus className="w-3.5 h-3.5" />}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* ── TAB: Decisão ── */}
                                {drawerTab === 'decision' && (
                                    <div className="space-y-4">
                                        {selected.decisions.length === 0 ? (
                                            <p className="text-sm text-muted-foreground">Nenhuma decisão arquitetural criada ainda.</p>
                                        ) : (
                                            selected.decisions.map(dec => (
                                                <div key={dec.id} className="rounded-lg border border-border/40 bg-secondary/10 p-4 space-y-3">
                                                    <div className="flex items-center justify-between">
                                                        <p className="text-sm font-semibold text-foreground">{dec.recommended_option}</p>
                                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${statusBadge(dec.status)}`}>
                                                            {dec.status}
                                                        </span>
                                                    </div>
                                                    <div>
                                                        <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Racional</p>
                                                        <p className="text-xs text-foreground whitespace-pre-wrap">{dec.rationale_md}</p>
                                                    </div>

                                                    {/* Decision actions */}
                                                    {['admin', 'operator'].includes(role) && (
                                                        <div className="flex flex-wrap gap-2 pt-1">
                                                            {dec.status === 'draft' && (
                                                                <button
                                                                    onClick={async () => {
                                                                        try {
                                                                            await api.post(ENDPOINTS.ARCHITECT_DECISION_PROPOSE(dec.id), {});
                                                                            showToast('Decisão proposta', 'success');
                                                                            openCase(selected.case.id);
                                                                        } catch { showToast('Erro', 'error'); }
                                                                    }}
                                                                    className="px-3 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
                                                                >
                                                                    Propor
                                                                </button>
                                                            )}
                                                            {dec.status === 'proposed' && (
                                                                <>
                                                                    <button
                                                                        onClick={async () => {
                                                                            try {
                                                                                await api.post(ENDPOINTS.ARCHITECT_DECISION_APPROVE(dec.id), {});
                                                                                showToast('Decisão aprovada', 'success');
                                                                                openCase(selected.case.id);
                                                                            } catch { showToast('Erro', 'error'); }
                                                                        }}
                                                                        className="px-3 py-1 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                                                                    >
                                                                        Aprovar
                                                                    </button>
                                                                    <button
                                                                        onClick={async () => {
                                                                            try {
                                                                                await api.post(ENDPOINTS.ARCHITECT_DECISION_REJECT(dec.id), { reason: 'Rejeitado pelo revisor' });
                                                                                showToast('Decisão rejeitada', 'success');
                                                                                openCase(selected.case.id);
                                                                            } catch { showToast('Erro', 'error'); }
                                                                        }}
                                                                        className="px-3 py-1 rounded-md text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white transition-colors"
                                                                    >
                                                                        Rejeitar
                                                                    </button>
                                                                </>
                                                            )}
                                                            {dec.status === 'approved' && (
                                                                <button
                                                                    onClick={() => handleGenerateDocument(dec.id)}
                                                                    disabled={generatingDoc}
                                                                    className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
                                                                >
                                                                    <FileText className="w-3 h-3" />
                                                                    {generatingDoc ? 'Gerando...' : 'Gerar ADR'}
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            ))
                                        )}

                                        {/* Generated ADR document */}
                                        {generatedDoc && (
                                            <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-4">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <FileText className="w-4 h-4 text-violet-400" />
                                                    <p className="text-xs font-semibold text-violet-400 uppercase tracking-wider">ADR Gerado</p>
                                                </div>
                                                <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
                                                    {generatedDoc}
                                                </pre>
                                            </div>
                                        )}

                                        {/* Work items */}
                                        {selected.workItems.length > 0 && (
                                            <div>
                                                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-2">Work Items</p>
                                                <div className="space-y-1.5">
                                                    {selected.workItems.map(wi => (
                                                        <div key={wi.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/10 border border-border/20">
                                                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${statusBadge(wi.status)}`}>
                                                                {wi.status}
                                                            </span>
                                                            <span className="text-xs text-foreground flex-1 truncate">{wi.title}</span>
                                                            <span className="text-xs text-muted-foreground shrink-0">{wi.item_type}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Section C: New Case Modal */}
            {showNewCase && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-lg rounded-2xl border border-border/50 bg-card shadow-2xl p-6 space-y-4 mx-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-base font-bold text-foreground">Nova Demanda</h2>
                            <button onClick={() => setShowNewCase(false)} className="p-1.5 rounded-lg hover:bg-secondary/40 text-muted-foreground transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <label className="block text-xs font-medium text-muted-foreground mb-1">Título *</label>
                                <input
                                    type="text"
                                    value={newTitle}
                                    onChange={e => setNewTitle(e.target.value)}
                                    placeholder="Ex: Implementar modelo de análise de crédito"
                                    className="w-full px-3 py-2 rounded-lg bg-background border border-border/50 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-muted-foreground mb-1">Descrição</label>
                                <textarea
                                    value={newDesc}
                                    onChange={e => setNewDesc(e.target.value)}
                                    rows={3}
                                    placeholder="Contexto adicional sobre a demanda..."
                                    className="w-full px-3 py-2 rounded-lg bg-background border border-border/50 text-sm text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">Tipo de Origem</label>
                                    <select
                                        value={newSourceType}
                                        onChange={e => setNewSourceType(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg bg-background border border-border/50 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                    >
                                        <option value="internal">Interno</option>
                                        <option value="external">Externo</option>
                                        <option value="regulatory">Regulatório</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">Prioridade</label>
                                    <select
                                        value={newPriority}
                                        onChange={e => setNewPriority(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg bg-background border border-border/50 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                    >
                                        <option value="low">Baixa</option>
                                        <option value="medium">Média</option>
                                        <option value="high">Alta</option>
                                        <option value="critical">Crítica</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                onClick={() => setShowNewCase(false)}
                                className="px-4 py-2 rounded-lg border border-border/40 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={createCase}
                                disabled={creating || !newTitle.trim()}
                                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                            >
                                {creating ? 'Criando...' : 'Criar Demanda'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
