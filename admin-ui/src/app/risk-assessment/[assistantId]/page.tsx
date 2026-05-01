'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    ShieldCheck, ChevronRight, ChevronLeft, CheckCircle2,
    AlertTriangle, AlertOctagon, XCircle, Download, RotateCcw,
    Loader2,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { RISK_QUESTIONS, CATEGORY_LABELS, computeRiskScore, RiskQuestion } from '@/lib/risk-questions';

// ── Types ─────────────────────────────────────────────────────────────────

type CategoryKey = 'data_protection' | 'human_oversight' | 'transparency' | 'security' | 'fairness';

const CATEGORIES: CategoryKey[] = ['data_protection', 'human_oversight', 'transparency', 'security', 'fairness'];

const CATEGORY_ICONS: Record<CategoryKey, string> = {
    data_protection: '🔒',
    human_oversight: '👁️',
    transparency: '📋',
    security: '🛡️',
    fairness: '⚖️',
};

// ── Risk level helpers ─────────────────────────────────────────────────────

function riskLevelConfig(level: string) {
    switch (level) {
        case 'low':      return { label: 'Risco Baixo',    color: 'text-success-fg', bg: 'bg-success-bg border-emerald-500/20', Icon: CheckCircle2 };
        case 'medium':   return { label: 'Risco Médio',    color: 'text-warning-fg',   bg: 'bg-warning-bg border-amber-400/20',     Icon: AlertTriangle };
        case 'high':     return { label: 'Risco Alto',     color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/20',   Icon: AlertTriangle };
        case 'critical': return { label: 'Risco Crítico',  color: 'text-danger-fg',    bg: 'bg-danger-bg border-rose-500/20',       Icon: XCircle };
        default:         return { label: level,            color: 'text-gray-400',    bg: 'bg-gray-500/10 border-gray-500/20',       Icon: AlertOctagon };
    }
}

function scoreColor(score: number) {
    if (score >= 75) return 'text-success-fg';
    if (score >= 50) return 'text-warning-fg';
    if (score >= 25) return 'text-orange-400';
    return 'text-danger-fg';
}

// ── Question Component ────────────────────────────────────────────────────

function QuestionItem({
    question,
    answer,
    onChange,
}: {
    question: RiskQuestion;
    answer: any;
    onChange: (id: string, value: any) => void;
}) {
    return (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-3">
            <div>
                <div className="flex items-start gap-2">
                    <span className="text-xs text-gray-500 mt-0.5 font-mono">[w:{question.weight}]</span>
                    <p className="text-sm font-medium text-white">{question.question}</p>
                </div>
                <p className="text-xs text-gray-500 mt-1 ml-8">{question.description}</p>
            </div>

            {question.type === 'yes_no' && (
                <div className="flex gap-2 ml-8">
                    {['yes', 'no'].map(opt => (
                        <button
                            key={opt}
                            onClick={() => onChange(question.id, opt)}
                            className={`px-4 py-1.5 text-xs rounded-lg border transition-colors ${
                                answer === opt
                                    ? 'bg-violet-600 border-violet-500 text-white'
                                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                            }`}
                        >
                            {opt === 'yes' ? 'Sim' : 'Não'}
                        </button>
                    ))}
                    {answer !== undefined && (
                        <span className={`text-xs ml-2 self-center font-medium ${
                            (question.scoring[answer] ?? 0) >= 50 ? 'text-success-fg' : 'text-danger-fg'
                        }`}>
                            {question.scoring[answer] ?? 0} pts
                        </span>
                    )}
                </div>
            )}

            {question.type === 'scale' && (
                <div className="flex gap-2 ml-8">
                    {[1, 2, 3, 4, 5].map(n => (
                        <button
                            key={n}
                            onClick={() => onChange(question.id, String(n))}
                            className={`w-8 h-8 text-xs rounded-lg border transition-colors ${
                                answer === String(n)
                                    ? 'bg-violet-600 border-violet-500 text-white'
                                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                            }`}
                        >
                            {n}
                        </button>
                    ))}
                </div>
            )}

            {question.type === 'select' && question.options && (
                <div className="flex flex-wrap gap-2 ml-8">
                    {question.options.map(opt => (
                        <button
                            key={opt}
                            onClick={() => onChange(question.id, opt)}
                            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                                answer === opt
                                    ? 'bg-violet-600 border-violet-500 text-white'
                                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                            }`}
                        >
                            {opt}
                        </button>
                    ))}
                    {answer !== undefined && (
                        <span className={`text-xs ml-1 self-center font-medium ${
                            (question.scoring[answer] ?? 0) >= 50 ? 'text-success-fg' : 'text-danger-fg'
                        }`}>
                            {question.scoring[answer] ?? 0} pts
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function RiskAssessmentPage() {
    const params = useParams();
    const router = useRouter();
    const assistantId = params.assistantId as string;
    const { orgId } = useAuth();
    const { toast } = useToast();

    const [step, setStep] = useState(0); // 0 = intro, 1-5 = categories, 6 = result
    const [assessmentId, setAssessmentId] = useState<string | null>(null);
    const [answers, setAnswers] = useState<Record<string, any>>({});
    const [result, setResult] = useState<any | null>(null);
    const [assistantName, setAssistantName] = useState('');
    const [starting, setStarting] = useState(false);
    const [completing, setCompleting] = useState(false);
    const [autoSaveTimer, setAutoSaveTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

    // Load assistant name
    useEffect(() => {
        api.get(`/v1/admin/assistants/${assistantId}`)
            .then((res: any) => setAssistantName(res.data?.name || 'Assistente'))
            .catch(() => setAssistantName('Assistente'));
    }, [assistantId]);

    const handleStart = async () => {
        setStarting(true);
        try {
            const res = await api.post(ENDPOINTS.RISK_ASSESSMENT_CREATE(assistantId), {});
            setAssessmentId(res.data.id);
            setAnswers({});
            setStep(1);
        } catch {
            toast('Erro ao iniciar avaliação', 'error');
        } finally {
            setStarting(false);
        }
    };

    const handleAnswer = (id: string, value: any) => {
        const newAnswers = { ...answers, [id]: value };
        setAnswers(newAnswers);

        // Debounced auto-save
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        if (assessmentId) {
            const t = setTimeout(async () => {
                try {
                    await api.put(ENDPOINTS.RISK_ASSESSMENT_ANSWERS(assessmentId), { answers: newAnswers });
                } catch {
                    // silent
                }
            }, 1000);
            setAutoSaveTimer(t);
        }
    };

    const currentCategory = CATEGORIES[step - 1] as CategoryKey;
    const currentQuestions = step >= 1 && step <= 5
        ? RISK_QUESTIONS.filter(q => q.category === currentCategory)
        : [];

    const currentCategoryAnswered = currentQuestions.every(q => answers[q.id] !== undefined);
    const totalAnswered = RISK_QUESTIONS.filter(q => answers[q.id] !== undefined).length;
    const totalQuestions = RISK_QUESTIONS.length;

    const handleComplete = async () => {
        if (!assessmentId) return;
        setCompleting(true);
        try {
            // Save final answers first
            await api.put(ENDPOINTS.RISK_ASSESSMENT_ANSWERS(assessmentId), { answers });
            const res = await api.post(ENDPOINTS.RISK_ASSESSMENT_COMPLETE(assessmentId), {});
            setResult(res.data);
            setStep(6);
        } catch {
            toast('Erro ao finalizar avaliação', 'error');
        } finally {
            setCompleting(false);
        }
    };

    const handleExport = async () => {
        if (!assessmentId) return;
        try {
            const res = await api.get(ENDPOINTS.RISK_ASSESSMENT_EXPORT(assessmentId));
            const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `risk-assessment-${assistantName.replace(/\s/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            toast('Erro ao exportar', 'error');
        }
    };

    // Live score preview
    const liveScore = computeRiskScore(answers);

    return (
        <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    onClick={() => router.back()}
                    className="text-gray-500 hover:text-white transition-colors"
                >
                    <ChevronLeft className="w-5 h-5" />
                </button>
                <div>
                    <h1 className="text-lg font-semibold text-white flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-violet-400" />
                        Avaliação de Risco de IA
                    </h1>
                    <p className="text-sm text-gray-500">{assistantName}</p>
                </div>
            </div>

            {/* Progress bar */}
            {step > 0 && step <= 5 && (
                <div className="space-y-2">
                    <div className="flex justify-between text-xs text-gray-500">
                        <span>{totalAnswered}/{totalQuestions} perguntas respondidas</span>
                        <span>Etapa {step}/5</span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                        <div
                            className="h-1.5 rounded-full bg-violet-500 transition-all"
                            style={{ width: `${(step - 1) * 20 + (currentQuestions.filter(q => answers[q.id] !== undefined).length / Math.max(1, currentQuestions.length)) * 20}%` }}
                        />
                    </div>
                </div>
            )}

            {/* STEP 0: Intro */}
            {step === 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center space-y-4">
                    <div className="w-16 h-16 bg-violet-600/20 rounded-2xl flex items-center justify-center mx-auto">
                        <ShieldCheck className="w-8 h-8 text-violet-400" />
                    </div>
                    <div>
                        <h2 className="text-xl font-semibold text-white">Avaliação de Risco</h2>
                        <p className="text-gray-500 text-sm mt-2">
                            Responda 25 perguntas em 5 categorias para calcular o perfil de risco do assistente.
                            O resultado será usado para atualizar automaticamente o status de conformidade regulatória.
                        </p>
                    </div>
                    <div className="flex justify-center gap-4 text-sm text-gray-500">
                        {CATEGORIES.map(cat => (
                            <div key={cat} className="flex items-center gap-1">
                                <span>{CATEGORY_ICONS[cat]}</span>
                                <span>{CATEGORY_LABELS[cat]}</span>
                            </div>
                        ))}
                    </div>
                    <button
                        onClick={handleStart}
                        disabled={starting}
                        className="px-6 py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center gap-2 mx-auto"
                    >
                        {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                        Iniciar Avaliação
                    </button>
                </div>
            )}

            {/* STEPS 1-5: Category questions */}
            {step >= 1 && step <= 5 && (
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <span className="text-2xl">{CATEGORY_ICONS[currentCategory]}</span>
                        <div>
                            <h2 className="font-semibold text-white">{CATEGORY_LABELS[currentCategory]}</h2>
                            <p className="text-xs text-gray-500">{currentQuestions.length} perguntas nesta categoria</p>
                        </div>
                        {/* Live category score */}
                        {liveScore.categoryScores[currentCategory] !== undefined && (
                            <div className="ml-auto text-right">
                                <span className={`text-2xl font-bold ${scoreColor(liveScore.categoryScores[currentCategory])}`}>
                                    {Math.round(liveScore.categoryScores[currentCategory])}
                                </span>
                                <span className="text-xs text-gray-500"> / 100</span>
                            </div>
                        )}
                    </div>

                    <div className="space-y-3">
                        {currentQuestions.map(q => (
                            <QuestionItem
                                key={q.id}
                                question={q}
                                answer={answers[q.id]}
                                onChange={handleAnswer}
                            />
                        ))}
                    </div>

                    <div className="flex gap-3 justify-between pt-2">
                        <button
                            onClick={() => setStep(s => s - 1)}
                            className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-xl transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4" />
                            Anterior
                        </button>

                        {step < 5 ? (
                            <button
                                onClick={() => setStep(s => s + 1)}
                                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-xl transition-colors"
                            >
                                Próxima categoria
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        ) : (
                            <button
                                onClick={handleComplete}
                                disabled={completing || totalAnswered < totalQuestions}
                                className="flex items-center gap-1.5 px-5 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors disabled:opacity-50"
                            >
                                {completing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                Finalizar ({totalAnswered}/{totalQuestions})
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* STEP 6: Result */}
            {step === 6 && result && (() => {
                const cfg = riskLevelConfig(result.risk_level);
                const Icon = cfg.Icon;
                return (
                    <div className="space-y-4">
                        {/* Score hero */}
                        <div className={`border rounded-2xl p-6 text-center space-y-2 ${cfg.bg}`}>
                            <Icon className={`w-10 h-10 mx-auto ${cfg.color}`} />
                            <div className={`text-5xl font-bold ${cfg.color}`}>{result.total_score}</div>
                            <div className="text-xs text-gray-500">/ 100 pontos</div>
                            <div className={`text-lg font-semibold ${cfg.color}`}>{cfg.label}</div>
                        </div>

                        {/* Category scores */}
                        {result.category_scores && (
                            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                                <h3 className="text-sm font-medium text-gray-400">Scores por Categoria</h3>
                                {CATEGORIES.map(cat => {
                                    const score = Math.round(result.category_scores[cat] ?? 0);
                                    return (
                                        <div key={cat} className="space-y-1">
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-400">
                                                    {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                                                </span>
                                                <span className={scoreColor(score)}>{score}/100</span>
                                            </div>
                                            <div className="w-full bg-gray-800 rounded-full h-1.5">
                                                <div
                                                    className={`h-1.5 rounded-full transition-all ${
                                                        score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-400' : score >= 25 ? 'bg-orange-400' : 'bg-rose-500'
                                                    }`}
                                                    style={{ width: `${score}%` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Recommendations */}
                        {result.recommendations?.length > 0 && (
                            <div className="bg-gray-900 border border-amber-500/20 rounded-xl p-4 space-y-2">
                                <h3 className="text-sm font-medium text-warning-fg flex items-center gap-1.5">
                                    <AlertTriangle className="w-4 h-4" />
                                    Recomendações ({result.recommendations.length})
                                </h3>
                                <ul className="space-y-1.5">
                                    {result.recommendations.map((rec: string, i: number) => (
                                        <li key={i} className="text-xs text-gray-400 flex gap-2">
                                            <span className="text-warning-fg mt-0.5">•</span>
                                            {rec}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {result.total_score >= 70 && (
                            <div className="bg-success-bg border border-emerald-500/20 rounded-xl p-3 text-xs text-success-fg">
                                ✓ Score ≥ 70 — controles de gerenciamento de risco atualizados automaticamente no Compliance Hub.
                            </div>
                        )}

                        <div className="flex gap-3">
                            <button
                                onClick={handleExport}
                                className="flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white rounded-xl transition-colors"
                            >
                                <Download className="w-4 h-4" />
                                Exportar JSON
                            </button>
                            <button
                                onClick={() => { setStep(0); setAssessmentId(null); setAnswers({}); setResult(null); }}
                                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-xl transition-colors"
                            >
                                <RotateCcw className="w-4 h-4" />
                                Nova Avaliação
                            </button>
                        </div>
                    </div>
                );
            })()}
        </div>
        </div>
    );
}
