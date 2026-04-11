'use client';

import { useEffect, useState, useCallback } from 'react';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';
import {
    BrainCircuit, Plus, RefreshCw, ChevronRight,
    ClipboardList, Search, CheckCircle2, GitBranch,
    X, FileText, MessageSquare, Layers, AlertTriangle,
    Workflow, Play, Clock, ChevronDown, ChevronUp,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/Badge';

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
    execution_hint: string | null;
    execution_context: {
        output?: { snippets?: unknown[]; fullText?: string; toolEvents?: { name: string }[] };
        adapter?: string;
    } | null;
    worker_session_id?: string | null;
}

interface DemandCaseFull {
    case: DemandCase;
    contract: ProblemContract | null;
    decisions: DecisionSet[];
    workflow: WorkflowGraph | null;
    workItems: WorkItem[];
}

interface WorkflowTemplatePhase {
    name: string;
    description?: string;
    execution_hint?: string;
    auto_advance?: boolean;
}

interface WorkflowTemplate {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    phases: WorkflowTemplatePhase[];
    default_execution_hint: string;
    estimated_duration_minutes: number | null;
    is_active: boolean;
    is_system: boolean;
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
    const [loadError, setLoadError] = useState<string | null>(null);

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

    // Dispatch
    const [dispatchingItemId, setDispatchingItemId] = useState<string | null>(null);
    const [dispatchingAll, setDispatchingAll] = useState(false);
    const [cancellingItemId, setCancellingItemId] = useState<string | null>(null);
    const [expandedOutputId, setExpandedOutputId] = useState<string | null>(null);

    // Templates (FASE 5c)
    const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
    const [loadingTemplates, setLoadingTemplates] = useState(false);
    const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);
    const [instantiatingId, setInstantiatingId] = useState<string | null>(null);

    // Case summary
    const [caseSummary, setCaseSummary] = useState<{
        caseId: string; caseTitle: string; caseStatus: string; priority: string;
        contractGoal: string | null; contractStatus: string | null; confidenceScore: number;
        decisionCount: number; approvedDecision: string | null;
        workItemCount: number; workItemsDone: number; workItemsPending: number;
        workItemsBlocked: number; completionPercentage: number; generatedAt: string;
    } | null>(null);
    const [loadingSummary, setLoadingSummary] = useState(false);

    const loadCases = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const res = await api.get(ENDPOINTS.ARCHITECT_CASES);
            setCases(res.data.cases ?? []);
            setTotal(res.data.total ?? 0);
        } catch {
            showToast('Erro ao carregar casos', 'error');
            setLoadError('Não foi possível carregar os casos de demanda.');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    const loadTemplates = useCallback(async () => {
        setLoadingTemplates(true);
        try {
            const res = await api.get(ENDPOINTS.ARCHITECT_TEMPLATES);
            setTemplates(res.data ?? []);
        } catch {
            // Silent fail — templates section just shows empty
        } finally {
            setLoadingTemplates(false);
        }
    }, []);

    useEffect(() => {
        loadCases();
        loadTemplates();
    }, [loadCases, loadTemplates]);

    const instantiateTemplate = async (template: WorkflowTemplate) => {
        setInstantiatingId(template.id);
        try {
            const res = await api.post(ENDPOINTS.ARCHITECT_TEMPLATE_INSTANTIATE(template.id), {
                title: `${template.name} — ${new Date().toLocaleDateString('pt-BR')}`,
                description: template.description || `Instanciado a partir de ${template.name}`,
                priority: 'medium',
            });
            showToast(`Workflow criado com ${res.data.work_items_created} fases`, 'success');
            await loadCases();
            // Open the newly created case
            const caseId = res.data.demand_case_id || res.data.case_id;
            if (caseId) {
                setDrawerTab('demand');
                openCase(caseId);
            }
        } catch {
            showToast('Erro ao instanciar template', 'error');
        } finally {
            setInstantiatingId(null);
        }
    };

    const openCase = useCallback(async (caseId: string) => {
        setDrawerLoading(true);
        setSelected(null);
        setDiscoveryStatus(null);
        setGeneratedDoc(null);
        setCaseSummary(null);
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

    const handleGenerateSummary = async () => {
        if (!selected) return;
        setLoadingSummary(true);
        try {
            const res = await api.get(ENDPOINTS.ARCHITECT_CASE_SUMMARY(selected.case.id));
            setCaseSummary(res.data.summary);
        } catch {
            showToast('Erro ao gerar resumo', 'error');
        } finally {
            setLoadingSummary(false);
        }
    };

    const handleDispatchItem = async (workItemId: string) => {
        if (!selected) return;
        setDispatchingItemId(workItemId);
        try {
            await api.post(ENDPOINTS.ARCHITECT_WORK_ITEM_DISPATCH(workItemId), {});
            showToast('Work item despachado com sucesso', 'success');
            openCase(selected.case.id);
        } catch {
            showToast('Erro ao despachar work item', 'error');
        } finally {
            setDispatchingItemId(null);
        }
    };

    const handleCancelItem = async (workItemId: string) => {
        if (!selected) return;
        setCancellingItemId(workItemId);
        try {
            await api.post(ENDPOINTS.ARCHITECT_WORK_ITEM_CANCEL(workItemId), {});
            showToast('Work item cancelado', 'success');
            openCase(selected.case.id);
        } catch {
            showToast('Erro ao cancelar work item', 'error');
        } finally {
            setCancellingItemId(null);
        }
    };

    const handleDispatchAll = async (workflowId: string) => {
        if (!selected) return;
        setDispatchingAll(true);
        try {
            const res = await api.post(ENDPOINTS.ARCHITECT_WORKFLOW_DISPATCH_ALL(selected.case.id), {
                workflow_graph_id: workflowId,
            });
            const dispatched: number = res.data.total ?? (Array.isArray(res.data.dispatched) ? res.data.dispatched.length : 0);
            showToast(`${dispatched} work items despachados`, 'success');
            openCase(selected.case.id);
        } catch {
            showToast('Erro ao despachar work items', 'error');
        } finally {
            setDispatchingAll(false);
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
        <div className="flex-1 flex flex-col overflow-hidden">

            {/* Header */}
            <div className="p-4 sm:p-6 border-b border-border/50 shrink-0">
                <PageHeader
                    title="Arquiteto"
                    subtitle="Intake e decisão arquitetural"
                    icon={<BrainCircuit className="w-5 h-5" />}
                />
            </div>

            {/* Section A: Status bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-8 py-4 border-b border-border/30 shrink-0">
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

            {/* Section A2: Workflow Templates (FASE 5c) */}
            {(templates.length > 0 || loadingTemplates) && (
                <div className="px-8 py-4 border-b border-border/30 shrink-0">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Workflow className="w-4 h-4 text-violet-400" />
                            <h3 className="text-sm font-semibold text-foreground">Templates de Workflow</h3>
                            <span className="text-xs text-muted-foreground">({templates.length})</span>
                        </div>
                    </div>

                    {loadingTemplates ? (
                        <div className="flex gap-3">
                            <SkeletonCard />
                            <SkeletonCard />
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {templates.map(tpl => {
                                const isExpanded = expandedTemplateId === tpl.id;
                                const isInstantiating = instantiatingId === tpl.id;
                                const categoryColor =
                                    tpl.category === 'security' ? 'text-rose-400 bg-rose-500/10 border-rose-500/20' :
                                    tpl.category === 'development' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' :
                                    tpl.category === 'review' ? 'text-violet-400 bg-violet-500/10 border-violet-500/20' :
                                    tpl.category === 'compliance' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' :
                                    'text-muted-foreground bg-secondary/20 border-border/30';

                                return (
                                    <div key={tpl.id} className="rounded-lg border border-border/40 bg-card/50 overflow-hidden">
                                        <div className="p-3">
                                            <div className="flex items-start justify-between gap-2 mb-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-medium text-sm text-foreground truncate">{tpl.name}</div>
                                                    {tpl.description && (
                                                        <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{tpl.description}</div>
                                                    )}
                                                </div>
                                                {tpl.is_system && (
                                                    <Badge variant="neutral" className="text-[10px]">sistema</Badge>
                                                )}
                                            </div>

                                            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                                                <span className="flex items-center gap-1">
                                                    <Layers className="w-3 h-3" />
                                                    {tpl.phases?.length || 0} fases
                                                </span>
                                                {tpl.estimated_duration_minutes && (
                                                    <>
                                                        <span>·</span>
                                                        <span className="flex items-center gap-1">
                                                            <Clock className="w-3 h-3" />
                                                            ~{tpl.estimated_duration_minutes} min
                                                        </span>
                                                    </>
                                                )}
                                                {tpl.category && (
                                                    <>
                                                        <span>·</span>
                                                        <span className={`px-1.5 py-0.5 rounded border text-[10px] ${categoryColor}`}>
                                                            {tpl.category}
                                                        </span>
                                                    </>
                                                )}
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => instantiateTemplate(tpl)}
                                                    disabled={isInstantiating || role !== 'admin'}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    <Play className="w-3 h-3" />
                                                    {isInstantiating ? 'Criando...' : 'Instanciar'}
                                                </button>
                                                <button
                                                    onClick={() => setExpandedTemplateId(isExpanded ? null : tpl.id)}
                                                    className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                                >
                                                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                    Ver fases
                                                </button>
                                            </div>
                                        </div>

                                        {isExpanded && Array.isArray(tpl.phases) && tpl.phases.length > 0 && (
                                            <div className="border-t border-border/20 bg-secondary/10 px-3 py-2 space-y-1.5">
                                                {tpl.phases.map((phase, idx) => (
                                                    <div key={idx} className="flex items-start gap-2 text-xs">
                                                        <div className="w-5 h-5 rounded-full bg-secondary/40 flex items-center justify-center text-[10px] text-muted-foreground shrink-0">
                                                            {idx + 1}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="font-medium text-foreground">{phase.name}</div>
                                                            {phase.description && (
                                                                <div className="text-muted-foreground text-[11px] line-clamp-1">{phase.description}</div>
                                                            )}
                                                        </div>
                                                        {phase.execution_hint && (
                                                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-500/10 text-violet-400 border border-violet-500/20 shrink-0">
                                                                {phase.execution_hint}
                                                            </span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Section B: Cases table + drawer */}
            <div className="flex flex-1 overflow-hidden">

                {/* Table */}
                <div className="flex-1 overflow-auto px-8 py-4">
                    {loading && cases.length === 0 ? (
                        <SkeletonTable rows={5} cols={5} />
                    ) : loadError ? (
                        <div className="flex flex-col items-center justify-center h-48 gap-3">
                            <AlertTriangle className="w-8 h-8 text-destructive/70" />
                            <p className="text-sm text-destructive font-medium">{loadError}</p>
                            <button onClick={loadCases} className="text-xs text-muted-foreground underline hover:text-foreground transition-colors">Tentar novamente</button>
                        </div>
                    ) : cases.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3">
                            <BrainCircuit className="w-10 h-10 text-muted-foreground/30" />
                            <p className="text-sm">Nenhuma demanda encontrada. Crie a primeira.</p>
                        </div>
                    ) : (
                        <div className="rounded-xl border border-border/40 overflow-hidden">
                            <div className="overflow-x-auto">
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
                            </div>
                            <div className="px-4 py-2 border-t border-border/20 bg-secondary/10 text-xs text-muted-foreground">
                                {total} caso{total !== 1 ? 's' : ''} no total
                            </div>
                        </div>
                    )}
                </div>

                {/* Side drawer */}
                {selected !== null && (
                    <div className="w-full lg:w-[480px] border-l border-border/50 bg-card/40 flex flex-col overflow-hidden shrink-0">
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
                        <div role="tablist" className="flex border-b border-border/40 px-2 shrink-0">
                            {[
                                { id: 'demand', label: 'Demanda', icon: ClipboardList },
                                { id: 'discovery', label: 'Discovery', icon: Search },
                                { id: 'decision', label: 'Decisão', icon: GitBranch },
                            ].map(tab => (
                                <button
                                    key={tab.id}
                                    role="tab"
                                    aria-selected={drawerTab === tab.id}
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
                            <div className="p-5 space-y-3">
                                <SkeletonCard />
                                <SkeletonCard />
                            </div>
                        ) : (
                            <div className="flex-1 overflow-y-auto p-5 space-y-4">

                                {/* ── TAB: Demanda ── */}
                                {drawerTab === 'demand' && (
                                    <div role="tabpanel" className="space-y-4">
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

                                        {/* Case Summary */}
                                        <div>
                                            <button
                                                onClick={handleGenerateSummary}
                                                disabled={loadingSummary}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-600/20 hover:bg-violet-600/30 text-violet-400 border border-violet-500/20 transition-colors disabled:opacity-50"
                                            >
                                                <ClipboardList className="w-3 h-3" />
                                                {loadingSummary ? 'Gerando...' : 'Gerar Resumo'}
                                            </button>

                                            {caseSummary && caseSummary.caseId === selected.case.id && (
                                                <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 p-4 space-y-3">
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Resumo do Caso</span>
                                                        <span className={`text-2xl font-bold text-violet-400`}>
                                                            {caseSummary.completionPercentage}%
                                                        </span>
                                                    </div>
                                                    <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full rounded-full bg-violet-500 transition-all"
                                                            style={{ width: `${caseSummary.completionPercentage}%` }}
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                                        <div>
                                                            <span className="text-muted-foreground">Work Items</span>
                                                            <p className="text-foreground font-medium">{caseSummary.workItemsDone} / {caseSummary.workItemCount} concluídos</p>
                                                        </div>
                                                        <div>
                                                            <span className="text-muted-foreground">Confidence</span>
                                                            <p className={`font-medium ${confidenceColor(caseSummary.confidenceScore)}`}>{caseSummary.confidenceScore}%</p>
                                                        </div>
                                                        <div>
                                                            <span className="text-muted-foreground">Decisão Aprovada</span>
                                                            <p className="text-foreground font-medium truncate">{caseSummary.approvedDecision ?? 'Pendente'}</p>
                                                        </div>
                                                        <div>
                                                            <span className="text-muted-foreground">Status</span>
                                                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${statusBadge(caseSummary.caseStatus)}`}>
                                                                {caseSummary.caseStatus}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* ── TAB: Discovery ── */}
                                {drawerTab === 'discovery' && (
                                    <div role="tabpanel" className="space-y-4">
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
                                    <div role="tabpanel" className="space-y-4">
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
                                                <div className="flex items-center justify-between mb-2">
                                                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Work Items</p>
                                                    {role === 'admin' && selected.workflow && selected.workItems.some(wi => wi.status === 'pending') && (
                                                        <button
                                                            onClick={() => handleDispatchAll(selected.workflow!.id)}
                                                            disabled={dispatchingAll}
                                                            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
                                                        >
                                                            <GitBranch className="w-3 h-3" />
                                                            {dispatchingAll ? 'Despachando...' : 'Despachar Todos'}
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="space-y-1.5">
                                                    {selected.workItems.map(wi => (
                                                        <div key={wi.id} className="rounded-lg bg-secondary/10 border border-border/20 overflow-hidden">
                                                            {/* Main row */}
                                                            <div className="flex items-center gap-3 px-3 py-2">
                                                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${statusBadge(wi.status)}`}>
                                                                    {wi.status}
                                                                </span>
                                                                <span className="text-xs text-foreground flex-1 truncate">{wi.title}</span>

                                                                {/* OpenClaude badge */}
                                                                {wi.execution_hint === 'openclaude' && (
                                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20 shrink-0">
                                                                        🤖 OpenClaude
                                                                    </span>
                                                                )}

                                                                {/* In-progress spinner for OpenClaude */}
                                                                {wi.status === 'in_progress' && wi.execution_hint === 'openclaude' && (
                                                                    <span className="text-xs text-violet-400 shrink-0 animate-pulse">
                                                                        ⟳ Executando...
                                                                    </span>
                                                                )}

                                                                {/* RAG snippets count */}
                                                                {wi.execution_context?.output?.snippets && wi.execution_context.output.snippets.length > 0 && (
                                                                    <span className="text-xs text-violet-400 shrink-0">
                                                                        {wi.execution_context.output.snippets.length} snippets
                                                                    </span>
                                                                )}

                                                                {/* OpenClaude result link */}
                                                                {wi.status === 'done' && wi.execution_context?.adapter === 'openclaude' && wi.execution_context?.output?.fullText && (
                                                                    <button
                                                                        onClick={() => setExpandedOutputId(expandedOutputId === wi.id ? null : wi.id)}
                                                                        className="shrink-0 px-2 py-0.5 rounded text-xs font-medium text-violet-400 hover:text-violet-300 underline-offset-2 hover:underline transition-colors"
                                                                    >
                                                                        {expandedOutputId === wi.id ? 'Fechar' : 'Ver resultado'}
                                                                    </button>
                                                                )}

                                                                <span className="text-xs text-muted-foreground shrink-0">{wi.item_type}</span>

                                                                {/* Dispatch button */}
                                                                {wi.status === 'pending' && ['admin', 'operator'].includes(role) && (
                                                                    <button
                                                                        onClick={() => handleDispatchItem(wi.id)}
                                                                        disabled={dispatchingItemId === wi.id}
                                                                        className="shrink-0 px-2 py-0.5 rounded text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
                                                                    >
                                                                        {dispatchingItemId === wi.id ? '...' : 'Despachar'}
                                                                    </button>
                                                                )}

                                                                {/* Cancel button — OpenClaude in_progress */}
                                                                {wi.status === 'in_progress' && wi.execution_hint === 'openclaude' && role === 'admin' && (
                                                                    <button
                                                                        onClick={() => handleCancelItem(wi.id)}
                                                                        disabled={cancellingItemId === wi.id}
                                                                        className="shrink-0 px-2 py-0.5 rounded text-xs font-medium bg-destructive/80 hover:bg-destructive text-white transition-colors disabled:opacity-50"
                                                                    >
                                                                        {cancellingItemId === wi.id ? '...' : 'Cancelar'}
                                                                    </button>
                                                                )}
                                                            </div>

                                                            {/* Expandable OpenClaude output */}
                                                            {expandedOutputId === wi.id && wi.execution_context?.output?.fullText && (
                                                                <div className="px-3 pb-3 pt-1 border-t border-border/20">
                                                                    <div className="flex items-center justify-between mb-1">
                                                                        <span className="text-xs text-violet-400 font-medium">Resultado OpenClaude</span>
                                                                        {wi.execution_context.output.toolEvents && wi.execution_context.output.toolEvents.length > 0 && (
                                                                            <span className="text-xs text-muted-foreground">
                                                                                {wi.execution_context.output.toolEvents.length} tool calls
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words bg-background/50 rounded p-2 max-h-48 overflow-y-auto">
                                                                        {wi.execution_context.output.fullText}
                                                                    </pre>
                                                                </div>
                                                            )}
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
                <NewCaseModal
                    newTitle={newTitle} setNewTitle={setNewTitle}
                    newDesc={newDesc} setNewDesc={setNewDesc}
                    newSourceType={newSourceType} setNewSourceType={setNewSourceType}
                    newPriority={newPriority} setNewPriority={setNewPriority}
                    creating={creating} onClose={() => setShowNewCase(false)} onCreate={createCase}
                    role={role}
                />
            )}
        </div>
    );
}

// ── New Case Modal (extracted to enable useEscapeClose hook) ─────────────────

function NewCaseModal({ newTitle, setNewTitle, newDesc, setNewDesc, newSourceType, setNewSourceType, newPriority, setNewPriority, creating, onClose, onCreate, role }: {
    newTitle: string; setNewTitle: (v: string) => void;
    newDesc: string; setNewDesc: (v: string) => void;
    newSourceType: string; setNewSourceType: (v: string) => void;
    newPriority: string; setNewPriority: (v: string) => void;
    creating: boolean; onClose: () => void; onCreate: () => void; role: string;
}) {
    useEscapeClose(onClose);

    return (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="new-case-title"
                    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
                >
                    <div className="w-full max-w-lg rounded-2xl border border-border/50 bg-card shadow-2xl p-6 space-y-4 mx-4">
                        <div className="flex items-center justify-between">
                            <h2 id="new-case-title" className="text-base font-bold text-foreground">Nova Demanda</h2>
                            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary/40 text-muted-foreground transition-colors">
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
                                onClick={onClose}
                                className="px-4 py-2 rounded-lg border border-border/40 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={onCreate}
                                disabled={creating || !newTitle.trim()}
                                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                            >
                                {creating ? 'Criando...' : 'Criar Demanda'}
                            </button>
                        </div>
                    </div>
                </div>
    );
}
