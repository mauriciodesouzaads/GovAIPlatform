'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    ClipboardCheck, ChevronRight, RefreshCw, CheckCircle2,
    AlertCircle, Clock, BarChart2, Zap, ChevronDown, ChevronUp,
    Edit3, X,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────

interface Framework {
    id: string;
    name: string;
    description: string;
    version: string;
    region: string;
    total_controls: number;
    compliant_count: number;
    partial_count: number;
    non_compliant_count: number;
    compliance_rate: number;
}

interface Control {
    id: string;
    framework_id: string;
    control_id: string;
    title: string;
    description: string;
    category: string;
    govai_feature: string | null;
    auto_assessment: string;
    assessment_status: string | null;
    evidence_notes: string | null;
    assessed_at: string | null;
}

interface Summary {
    total_frameworks: number;
    total_controls: number;
    compliant: number;
    partial: number;
    non_compliant: number;
    not_assessed: number;
    compliance_rate: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function statusBadge(status: string | null) {
    if (!status) return <span className="text-xs text-gray-500 bg-gray-500/10 px-2 py-0.5 rounded-full">Não avaliado</span>;
    const map: Record<string, string> = {
        compliant: 'text-success-fg bg-success-bg',
        partial: 'text-warning-fg bg-warning-bg',
        non_compliant: 'text-danger-fg bg-danger-bg',
    };
    const label: Record<string, string> = {
        compliant: 'Conforme',
        partial: 'Parcial',
        non_compliant: 'Não conforme',
    };
    return (
        <span className={`text-xs px-2 py-0.5 rounded-full ${map[status] ?? 'text-gray-400 bg-gray-400/10'}`}>
            {label[status] ?? status}
        </span>
    );
}

function ProgressBar({ value, color = 'bg-emerald-500' }: { value: number; color?: string }) {
    return (
        <div className="w-full bg-gray-700 rounded-full h-1.5">
            <div
                className={`h-1.5 rounded-full ${color} transition-all`}
                style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
            />
        </div>
    );
}

function rateColor(rate: number) {
    if (rate >= 80) return 'text-success-fg';
    if (rate >= 50) return 'text-warning-fg';
    return 'text-danger-fg';
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function ComplianceHubPage() {
    const { orgId } = useAuth();
    const { toast } = useToast();

    const [summary, setSummary] = useState<Summary | null>(null);
    const [frameworks, setFrameworks] = useState<Framework[]>([]);
    const [selectedFramework, setSelectedFramework] = useState<Framework | null>(null);
    const [controls, setControls] = useState<Control[]>([]);
    const [loadingFrameworks, setLoadingFrameworks] = useState(true);
    const [loadingControls, setLoadingControls] = useState(false);
    const [assessingFramework, setAssessingFramework] = useState<string | null>(null);

    // Assessment modal
    const [editControl, setEditControl] = useState<Control | null>(null);
    const [editStatus, setEditStatus] = useState('');
    const [editNotes, setEditNotes] = useState('');
    const [savingAssessment, setSavingAssessment] = useState(false);

    const loadSummary = useCallback(async () => {
        try {
            const res = await api.get(ENDPOINTS.COMPLIANCE_HUB_SUMMARY);
            setSummary(res.data);
        } catch {
            // non-blocking
        }
    }, []);

    const loadFrameworks = useCallback(async () => {
        setLoadingFrameworks(true);
        try {
            const res = await api.get(ENDPOINTS.COMPLIANCE_HUB_FRAMEWORKS);
            setFrameworks(res.data);
        } catch (e: any) {
            toast('Erro ao carregar frameworks', 'error');
        } finally {
            setLoadingFrameworks(false);
        }
    }, [toast]);

    const loadControls = useCallback(async (frameworkId: string) => {
        setLoadingControls(true);
        try {
            const res = await api.get(ENDPOINTS.COMPLIANCE_HUB_CONTROLS(frameworkId));
            setControls(res.data);
        } catch {
            toast('Erro ao carregar controles', 'error');
        } finally {
            setLoadingControls(false);
        }
    }, [toast]);

    useEffect(() => {
        loadSummary();
        loadFrameworks();
    }, [loadSummary, loadFrameworks]);

    const handleSelectFramework = (fw: Framework) => {
        if (selectedFramework?.id === fw.id) {
            setSelectedFramework(null);
            setControls([]);
        } else {
            setSelectedFramework(fw);
            loadControls(fw.id);
        }
    };

    const handleAutoAssess = async (frameworkId: string) => {
        setAssessingFramework(frameworkId);
        try {
            const res = await api.post(ENDPOINTS.COMPLIANCE_HUB_AUTO_ASSESS(frameworkId), {});
            const result = res.data;
            toast(`Auto-avaliação concluída: ${result.passed} conformes, ${result.failed} falhos`, 'success');
            await loadFrameworks();
            if (selectedFramework?.id === frameworkId) {
                await loadControls(frameworkId);
            }
            await loadSummary();
        } catch {
            toast('Erro na auto-avaliação', 'error');
        } finally {
            setAssessingFramework(null);
        }
    };

    const openEditModal = (control: Control) => {
        setEditControl(control);
        setEditStatus(control.assessment_status || 'compliant');
        setEditNotes(control.evidence_notes || '');
    };

    const handleSaveAssessment = async () => {
        if (!editControl) return;
        setSavingAssessment(true);
        try {
            await api.put(ENDPOINTS.COMPLIANCE_HUB_ASSESSMENT(editControl.id), {
                status: editStatus,
                evidence_notes: editNotes,
            });
            toast('Avaliação salva', 'success');
            setEditControl(null);
            if (selectedFramework) {
                await loadControls(selectedFramework.id);
                await loadFrameworks();
                await loadSummary();
            }
        } catch {
            toast('Erro ao salvar avaliação', 'error');
        } finally {
            setSavingAssessment(false);
        }
    };

    return (
        <div className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
            <PageHeader
                title="Compliance Hub"
                subtitle="Mapeamento regulatório e avaliação de conformidade"
                icon={<ClipboardCheck className="w-5 h-5" />}
            />

            {/* Summary cards */}
            {summary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <SummaryCard label="Frameworks Ativos" value={summary.total_frameworks} icon={<BarChart2 className="w-4 h-4 text-info-fg" />} />
                    <SummaryCard label="Conformes" value={summary.compliant} icon={<CheckCircle2 className="w-4 h-4 text-success-fg" />} color="text-success-fg" />
                    <SummaryCard label="Não Avaliados" value={summary.not_assessed} icon={<Clock className="w-4 h-4 text-gray-400" />} color="text-gray-400" />
                    <SummaryCard label="Taxa Global" value={`${summary.compliance_rate}%`} icon={<BarChart2 className="w-4 h-4 text-violet-400" />} color={rateColor(summary.compliance_rate)} />
                </div>
            )}

            {/* Frameworks grid */}
            <div className="space-y-3">
                <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Frameworks Regulatórios</h2>

                {loadingFrameworks ? (
                    <div className="text-sm text-gray-500 py-8 text-center">Carregando frameworks...</div>
                ) : (
                    <div className="space-y-2">
                        {frameworks.map(fw => (
                            <div key={fw.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                                {/* Framework header row */}
                                <div
                                    className="flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-800/50 transition-colors"
                                    onClick={() => handleSelectFramework(fw)}
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-medium text-white text-sm">{fw.name}</span>
                                            <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{fw.version}</span>
                                            {fw.region && (
                                                <span className="text-xs text-gray-500">{fw.region}</span>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-500 truncate">{fw.description}</p>
                                    </div>

                                    <div className="flex items-center gap-6 shrink-0">
                                        <div className="text-right">
                                            <div className={`text-lg font-bold ${rateColor(fw.compliance_rate)}`}>
                                                {fw.compliance_rate}%
                                            </div>
                                            <div className="text-xs text-gray-500">{fw.compliant_count}/{fw.total_controls} controles</div>
                                        </div>

                                        <div className="w-28">
                                            <ProgressBar
                                                value={fw.compliance_rate}
                                                color={fw.compliance_rate >= 80 ? 'bg-emerald-500' : fw.compliance_rate >= 50 ? 'bg-amber-400' : 'bg-rose-500'}
                                            />
                                            <div className="flex gap-2 mt-1 text-xs text-gray-600">
                                                <span className="text-emerald-500">{fw.compliant_count}✓</span>
                                                <span className="text-warning-fg">{fw.partial_count}~</span>
                                                <span className="text-danger-fg">{fw.non_compliant_count}✗</span>
                                            </div>
                                        </div>

                                        <button
                                            className="flex items-center gap-1.5 text-xs bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                                            onClick={e => { e.stopPropagation(); handleAutoAssess(fw.id); }}
                                            disabled={assessingFramework === fw.id}
                                        >
                                            {assessingFramework === fw.id ? (
                                                <RefreshCw className="w-3 h-3 animate-spin" />
                                            ) : (
                                                <Zap className="w-3 h-3" />
                                            )}
                                            Auto-avaliar
                                        </button>

                                        {selectedFramework?.id === fw.id ? (
                                            <ChevronUp className="w-4 h-4 text-gray-500" />
                                        ) : (
                                            <ChevronDown className="w-4 h-4 text-gray-500" />
                                        )}
                                    </div>
                                </div>

                                {/* Controls table */}
                                {selectedFramework?.id === fw.id && (
                                    <div className="border-t border-gray-800">
                                        {loadingControls ? (
                                            <div className="text-sm text-gray-500 py-6 text-center">Carregando controles...</div>
                                        ) : (
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="bg-gray-800/50 text-xs text-gray-500 uppercase">
                                                        <th className="px-4 py-2 text-left">ID</th>
                                                        <th className="px-4 py-2 text-left">Controle</th>
                                                        <th className="px-4 py-2 text-left">Categoria</th>
                                                        <th className="px-4 py-2 text-left">Feature GovAI</th>
                                                        <th className="px-4 py-2 text-left">Status</th>
                                                        <th className="px-4 py-2 text-left">Avaliado em</th>
                                                        <th className="px-4 py-2" />
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-800/50">
                                                    {controls.map(ctrl => (
                                                        <tr key={ctrl.id} className="hover:bg-gray-800/30 transition-colors">
                                                            <td className="px-4 py-2.5 font-mono text-xs text-gray-400 whitespace-nowrap">{ctrl.control_id}</td>
                                                            <td className="px-4 py-2.5 max-w-xs">
                                                                <div className="font-medium text-white text-xs">{ctrl.title}</div>
                                                                <div className="text-gray-500 text-xs truncate">{ctrl.description}</div>
                                                            </td>
                                                            <td className="px-4 py-2.5 text-xs text-gray-400">{ctrl.category}</td>
                                                            <td className="px-4 py-2.5">
                                                                {ctrl.govai_feature ? (
                                                                    <span className="text-xs text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full">
                                                                        {ctrl.govai_feature}
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-gray-600 text-xs">—</span>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-2.5">{statusBadge(ctrl.assessment_status)}</td>
                                                            <td className="px-4 py-2.5 text-xs text-gray-500">
                                                                {ctrl.assessed_at ? new Date(ctrl.assessed_at).toLocaleDateString('pt-BR') : '—'}
                                                            </td>
                                                            <td className="px-4 py-2.5">
                                                                <button
                                                                    className="text-gray-500 hover:text-white transition-colors"
                                                                    onClick={() => openEditModal(ctrl)}
                                                                    title="Editar avaliação"
                                                                >
                                                                    <Edit3 className="w-3.5 h-3.5" />
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Assessment modal */}
            {editControl && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-4">
                        <div className="flex items-start justify-between">
                            <div>
                                <h3 className="font-semibold text-white">{editControl.title}</h3>
                                <p className="text-xs text-gray-500 mt-0.5">{editControl.control_id}</p>
                            </div>
                            <button onClick={() => setEditControl(null)} className="text-gray-500 hover:text-white">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div>
                            <label className="text-xs text-gray-400 mb-1 block">Status de Conformidade</label>
                            <select
                                value={editStatus}
                                onChange={e => setEditStatus(e.target.value)}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                            >
                                <option value="compliant">Conforme</option>
                                <option value="partial">Parcialmente Conforme</option>
                                <option value="non_compliant">Não Conforme</option>
                                <option value="not_applicable">Não Aplicável</option>
                            </select>
                        </div>

                        <div>
                            <label className="text-xs text-gray-400 mb-1 block">Notas de Evidência</label>
                            <textarea
                                value={editNotes}
                                onChange={e => setEditNotes(e.target.value)}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
                                rows={4}
                                placeholder="Descreva as evidências de conformidade..."
                            />
                        </div>

                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => setEditControl(null)}
                                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSaveAssessment}
                                disabled={savingAssessment}
                                className="px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors disabled:opacity-50"
                            >
                                {savingAssessment ? 'Salvando...' : 'Salvar'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
        </div>
    );
}

function SummaryCard({ label, value, icon, color = 'text-white' }: {
    label: string; value: string | number; icon: React.ReactNode; color?: string;
}) {
    return (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
            <div className="p-2 bg-gray-800 rounded-lg">{icon}</div>
            <div>
                <div className={`text-xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-gray-500">{label}</div>
            </div>
        </div>
    );
}
