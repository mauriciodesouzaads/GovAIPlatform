'use client';

import { useEffect, useCallback, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { claimLevelLabel, runtimeClassIcon } from '@/lib/runtime-label';
import { Plus, Upload, CheckCircle2, Bot, Database, Lock, FileText, AlertTriangle, X, FileCheck, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/components/Toast';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { PageHeader } from '@/components/PageHeader';
import { Badge, lifecycleBadge } from '@/components/Badge';

interface Assistant { id: string; name: string; status: string; created_at: string; draft_version_id?: string; }
export default function AssistantsPage() {
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [creating, setCreating] = useState(false);

    // MCP & Policies State
    const [selectedPolicyId, setSelectedPolicyId] = useState('');
    const [selectedMcpServerId, setSelectedMcpServerId] = useState('');
    const [allowedToolsInput, setAllowedToolsInput] = useState('');

    // RAG Upload State
    const [selectedAssistant, setSelectedAssistant] = useState<string | null>(null);
    const [kbId, setKbId] = useState<string | null>(null);
    const [docContent, setDocContent] = useState('');
    const [docTitle, setDocTitle] = useState('');
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState<string | null>(null);

    // Homologation State
    const [publishModalAst, setPublishModalAst] = useState<Assistant | null>(null);
    const [publishing, setPublishing] = useState(false);
    const [checklist, setChecklist] = useState({ data_privacy: false, injection_mitigation: false, legal_review: false });

    // New Version Modal State
    const [showNewVersionModal, setShowNewVersionModal] = useState(false);
    const [versionData, setVersionData] = useState({
        assistantId: '',
        policyJson: '{\n  "version": "1.0",\n  "rules": []\n}',
        changeType: 'patch' as 'major' | 'minor' | 'patch',
        changelog: '',
    });

    // FASE 5d: Delegation modal state
    const [delegationAst, setDelegationAst] = useState<Assistant | null>(null);
    const [delegationConfig, setDelegationConfig] = useState<{
        enabled: boolean;
        auto_delegate_patterns: string[];
        max_duration_seconds: number;
    }>({ enabled: false, auto_delegate_patterns: [], max_duration_seconds: 300 });
    const [delegationPatternsRaw, setDelegationPatternsRaw] = useState('');
    const [savingDelegation, setSavingDelegation] = useState(false);
    const [loadingDelegation, setLoadingDelegation] = useState(false);

    // FASE 7: runtime preference on the delegation modal. Populated from
    // GET /v1/admin/runtimes the first time the modal opens; persisted by
    // POST /v1/admin/runtime-switch on save. Starts empty so the first
    // render shows the default (openclaude).
    const [runtimeOptions, setRuntimeOptions] = useState<Array<{
        slug: string;
        display_name: string;
        runtime_class: string;
        claim_level: string;
        is_default: boolean;
        available: boolean;
    }>>([]);
    const [delegationRuntimeSlug, setDelegationRuntimeSlug] = useState<string>('openclaude');
    const [initialRuntimeSlug, setInitialRuntimeSlug] = useState<string>('openclaude');

    const openDelegationModal = async (ast: Assistant) => {
        setDelegationAst(ast);
        setLoadingDelegation(true);
        try {
            // Load delegation config + runtime catalog in parallel. The
            // runtime_profile_slug comes from the /delegation endpoint when
            // we extend it server-side (FASE 7). If it's not there yet we
            // fall back to the openclaude system default — the dropdown
            // still works, it just starts pre-selected on open.
            const [cfgRes, rtRes] = await Promise.all([
                api.get(ENDPOINTS.ASSISTANT_DELEGATION(ast.id)),
                api.get(ENDPOINTS.RUNTIMES).catch(() => ({ data: [] })),
            ]);
            const cfg = cfgRes.data.delegation_config || {
                enabled: false,
                auto_delegate_patterns: [],
                max_duration_seconds: 300,
            };
            setDelegationConfig(cfg);
            setDelegationPatternsRaw((cfg.auto_delegate_patterns || []).join('\n'));
            setRuntimeOptions(rtRes.data || []);
            // Prefer the slug returned by the delegation endpoint; fall
            // back to the row field (if we've already extended the GET)
            // and finally to 'openclaude'.
            const currentSlug: string =
                cfgRes.data?.runtime_profile_slug
                || (ast as any)?.runtime_profile_slug
                || 'openclaude';
            setDelegationRuntimeSlug(currentSlug);
            setInitialRuntimeSlug(currentSlug);
        } catch {
            toast('Erro ao carregar configuração de delegação', 'error');
        } finally {
            setLoadingDelegation(false);
        }
    };

    const saveDelegation = async () => {
        if (!delegationAst) return;
        setSavingDelegation(true);
        try {
            const patterns = delegationPatternsRaw
                .split('\n')
                .map(p => p.trim())
                .filter(Boolean);

            // Validate each pattern is a valid regex client-side
            for (const p of patterns) {
                try { new RegExp(p); } catch {
                    toast(`Pattern regex inválido: "${p}"`, 'error');
                    setSavingDelegation(false);
                    return;
                }
            }

            await api.put(ENDPOINTS.ASSISTANT_DELEGATION(delegationAst.id), {
                enabled: delegationConfig.enabled,
                auto_delegate_patterns: patterns,
                max_duration_seconds: delegationConfig.max_duration_seconds,
            });
            // FASE 7 — if the runtime slug changed, persist it via
            // /v1/admin/runtime-switch which (a) updates the assistant row
            // and (b) writes the switch to runtime_switch_audit so the
            // compliance page can render "who switched what, when, why".
            if (delegationRuntimeSlug !== initialRuntimeSlug) {
                try {
                    await api.post(ENDPOINTS.RUNTIME_SWITCH, {
                        scope_type: 'assistant',
                        scope_id: delegationAst.id,
                        runtime_slug: delegationRuntimeSlug,
                        reason: 'Assistant delegation settings',
                    });
                } catch {
                    toast('Falha ao trocar runtime — configuração de delegação foi salva.', 'error');
                }
            }
            toast('Configuração de delegação salva', 'success');
            setDelegationAst(null);
        } catch {
            toast('Erro ao salvar delegação', 'error');
        } finally {
            setSavingDelegation(false);
        }
    };

    const [fetchError, setFetchError] = useState(false);
    const { toast } = useToast();

    useEscapeClose(() => setShowNewVersionModal(false), showNewVersionModal);
    useEscapeClose(() => setPublishModalAst(null), publishModalAst !== null && !showNewVersionModal);

    const fetchAssistants = useCallback(async () => {
        setFetchError(false);
        try {
            const res = await api.get(ENDPOINTS.ASSISTANTS);
            setAssistants(res.data);
        } catch (e) {
            console.error(e);
            setFetchError(true);
        } finally { setLoading(false); }
    }, []);

    const fetchSelectables = async () => {
        try {
            const [polRes] = await Promise.all([
                api.get(ENDPOINTS.POLICIES),
                api.get(ENDPOINTS.MCP)
            ]);
            if (polRes.data.length > 0) setSelectedPolicyId(polRes.data[0].id);
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        // A autenticação SSO é gerenciada pelo AuthProvider via /v1/admin/me.
        // Sessão Bearer em memória/aba: o interceptor Axios injeta Authorization automaticamente.
        fetchAssistants();
        fetchSelectables();
    }, []);

    const createAssistant = async () => {
        if (!newName) return;
        setCreating(true);
        try {
            let tools: string[] = [];
            if (allowedToolsInput) {
                tools = allowedToolsInput.split(',').map((t: string) => t.trim()).filter((t: string) => t);
            }
            await api.post(ENDPOINTS.ASSISTANTS, {
                name: newName,
                systemPrompt: systemPrompt || undefined,
            });
            setNewName('');
            setSystemPrompt('');
            setAllowedToolsInput('');
            setSelectedMcpServerId('');
            fetchAssistants();
        } catch (e) { console.error(e); }
        finally { setCreating(false); }
    };

    const startRAG = async (assistantId: string) => {
        setSelectedAssistant(assistantId);
        setUploadResult(null);
        // Create a knowledge base for this assistant
        try {
            const res = await api.post(`${ENDPOINTS.ASSISTANTS}/${assistantId}/knowledge`,
                { name: 'Base Principal' }
            );
            setKbId(res.data.id);
        } catch (e) { console.error(e); }
    };

    const uploadDocument = async () => {
        if (!kbId || !docContent) return;
        setUploading(true);
        setUploadResult(null);
        try {
            const res = await api.post(`${ENDPOINTS.KNOWLEDGE}/${kbId}/documents`,
                { content: docContent, title: docTitle }
            );
            setUploadResult(res.data.message);
            setDocContent('');
            setDocTitle('');
        } catch (e: unknown) {
            const axiosError = e as { response?: { data?: { error?: string } }; message?: string };
            setUploadResult(`Erro: ${axiosError.response?.data?.error || axiosError.message}`);
        }
        finally { setUploading(false); }
    };

    const handlePublish = async () => {
        if (!publishModalAst) return;
        setPublishing(true);
        try {
            if (!publishModalAst.draft_version_id) {
                toast('Crie uma nova versão em rascunho antes de homologar e publicar.', 'error');
                setPublishing(false);
                return;
            }
            await api.post(`${ENDPOINTS.ASSISTANTS}/${publishModalAst.id}/versions/${publishModalAst.draft_version_id}/approve`, {
                checklist,
            });
            toast('Assistente homologado e publicado com sucesso!', 'success');
            setPublishModalAst(null);
            setChecklist({ data_privacy: false, injection_mitigation: false, legal_review: false });
            fetchAssistants();
        } catch (e: unknown) {
            const axiosError = e as { response?: { data?: { error?: string } } };
            toast(axiosError.response?.data?.error || "Erro ao publicar", 'error');
        } finally {
            setPublishing(false);
        }
    };

    const handleNewVersion = async () => {
        if (!versionData.assistantId) return;
        setPublishing(true);
        try {
            const policy = JSON.parse(versionData.policyJson);
            await api.post(`${ENDPOINTS.ASSISTANTS}/${versionData.assistantId}/versions`, {
                policy_json: policy,
                change_type: versionData.changeType,
                changelog: versionData.changelog || undefined,
            });
            toast('Versão criada em rascunho. Execute a homologação para publicar.', 'success');
            setShowNewVersionModal(false);
            fetchAssistants();
        } catch (e: unknown) {
            const error = e as { message?: string };
            toast(error.message || 'Erro ao publicar versão. Verifique o JSON.', 'error');
        } finally {
            setPublishing(false);
        }
    };

    return (
        <div className="flex-1 overflow-auto p-4 sm:p-6">
            <div className="max-w-6xl mx-auto space-y-8">
                <PageHeader
                    title="Assistants & RAG"
                    subtitle="Gerenciamento de assistentes"
                    icon={<Bot className="w-5 h-5" />}
                    actions={
                        <button
                            onClick={() => setShowNewVersionModal(true)}
                            className="flex items-center gap-2 px-4 py-2 bg-secondary border border-border rounded-lg text-sm font-semibold hover:bg-secondary/80 transition-colors"
                        >
                            <Upload className="w-4 h-4" /> Nova Versão
                        </button>
                    }
                />

                {/* Header Action */}
                <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h3 className="font-semibold flex items-center gap-2"><Plus className="w-4 h-4" /> Gestão de Assistentes</h3>
                        <p className="text-sm text-muted-foreground">Adicione novos agentes ou publique novas versões de políticas.</p>
                    </div>
                    <div className="flex gap-3">
                        <button onClick={() => setShowNewVersionModal(true)}
                            className="bg-foreground text-background font-medium text-sm px-6 py-2 rounded-md hover:bg-foreground/90 transition-colors flex items-center gap-2">
                            <Upload className="w-4 h-4" /> Criar Nova Versão
                        </button>
                        <div className="w-px h-8 bg-border" />
                        <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                                <input
                                    type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                                    placeholder="Novo Assistente..."
                                    className="bg-secondary border border-border rounded-md px-3 py-2 text-sm focus:outline-none w-40"
                                />
                                <button onClick={createAssistant} disabled={creating || !newName}
                                    className="bg-blue-600 text-white font-medium text-sm px-4 py-2 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50">
                                    Criar
                                </button>
                            </div>
                            <textarea
                                placeholder="Instruções do sistema (ex: Você é um assistente jurídico...)"
                                value={systemPrompt}
                                onChange={e => setSystemPrompt(e.target.value)}
                                rows={2}
                                className="bg-secondary border border-border rounded-md px-3 py-2 text-sm focus:outline-none w-full resize-none"
                            />
                        </div>
                    </div>
                </div>

                {/* Assistants Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {loading ? (
                        <div className="col-span-full h-40 bg-secondary rounded-xl animate-pulse" />
                    ) : fetchError ? (
                        <div className="col-span-full bg-destructive/10 border border-destructive/20 rounded-xl p-8 text-center space-y-3">
                            <AlertTriangle className="w-8 h-8 text-destructive mx-auto" />
                            <h3 className="text-lg font-semibold text-foreground">Erro ao carregar assistentes</h3>
                            <p className="text-sm text-muted-foreground">Não foi possível conectar ao servidor.</p>
                            <button onClick={fetchAssistants} className="text-sm text-primary hover:underline">
                                Tentar novamente
                            </button>
                        </div>
                    ) : assistants.length === 0 ? (
                        <div className="col-span-full py-12 text-center border border-dashed border-border rounded-xl text-muted-foreground">
                            Nenhum assistente criado. Crie o seu primeiro agente governado acima.
                        </div>
                    ) : (
                        assistants.map((ast: Assistant) => (
                            <div key={ast.id} className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col hover:border-emerald-500/30 transition-all hover:shadow-lg group">
                                <div className="flex justify-between items-start mb-4">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 group-hover:bg-emerald-500/20 transition-colors">
                                        <Bot className="w-5 h-5 text-emerald-500" />
                                    </div>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-widest border ${ast.status === 'published' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'}`}>
                                        {ast.status}
                                    </span>
                                </div>
                                <h3 className="font-bold text-lg text-foreground group-hover:text-emerald-400 transition-colors">{ast.name}</h3>
                                <p className="text-[10px] text-muted-foreground font-mono mt-1 flex items-center gap-1.5">
                                    <Lock className="w-3 h-3" />
                                    {ast.id}
                                </p>
                                <div className="mt-6 pt-4 border-t border-border/50 flex flex-col gap-2">
                                    <button onClick={() => startRAG(ast.id)}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-secondary/50 text-foreground hover:bg-secondary/70 border border-border transition-all">
                                        <Database className="w-3.5 h-3.5" /> Vetorizar Conhecimento
                                    </button>
                                    <button onClick={() => openDelegationModal(ast)}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 transition-all">
                                        <Workflow className="w-3.5 h-3.5" /> Delegação Autônoma
                                    </button>
                                    <Link href={`/evidence/${ast.id}`}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-all">
                                        <FileCheck className="w-3.5 h-3.5" /> Evidência
                                    </Link>
                                    {ast.status === 'draft' && (
                                        <button onClick={() => setPublishModalAst(ast)}
                                            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-emerald-500 text-black hover:bg-emerald-400 transition-all">
                                            <CheckCircle2 className="w-3.5 h-3.5" /> Homologar e Publicar
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* RAG Upload Modal */}
                {selectedAssistant && kbId && (
                    <div className="bg-card border-2 border-blue-500/30 rounded-xl p-6 shadow-lg space-y-4">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                            <Upload className="w-5 h-5 text-blue-500" /> Upload de Documento para RAG
                        </h3>
                        <p className="text-sm text-muted-foreground">Cole o conteúdo do documento abaixo. O sistema irá fatiar, vetorizar e armazenar para busca semântica.</p>

                        <input type="text" value={docTitle} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDocTitle(e.target.value)}
                            placeholder="Título do documento (ex: Regulamento Interno 2024)"
                            className="w-full bg-secondary border border-border rounded-md px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <textarea value={docContent} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDocContent(e.target.value)}
                            placeholder="Cole o conteúdo completo do documento aqui..."
                            rows={8}
                            className="w-full bg-secondary border border-border rounded-md px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                        />

                        <div className="flex items-center gap-4">
                            <button onClick={uploadDocument} disabled={uploading || !docContent}
                                className="bg-blue-600 text-white font-medium text-sm px-6 py-2.5 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2">
                                <FileText className="w-4 h-4" /> {uploading ? 'Vetorizando...' : 'Ingerir Documento'}
                            </button>
                            <button onClick={() => { setSelectedAssistant(null); setKbId(null); }}
                                className="text-muted-foreground text-sm hover:text-foreground">Cancelar</button>
                        </div>

                        {uploadResult && (
                            <div className={`rounded-lg p-4 text-sm ${uploadResult.startsWith('Erro') ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-500'} flex items-center gap-2`}>
                                <CheckCircle2 className="w-4 h-4 shrink-0" /> {uploadResult}
                            </div>
                        )}
                    </div>
                )}

                {/* New Version Publication Modal */}
                {showNewVersionModal && (
                    <div
                        className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-md p-4"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="new-version-title"
                        onClick={(e) => { if (e.target === e.currentTarget) setShowNewVersionModal(false); }}
                    >
                        <div className="bg-card w-full max-w-2xl rounded-3xl p-8 shadow-[0_0_50px_-12px_rgba(16,185,129,0.3)] border border-emerald-500/20 space-y-6 animate-in zoom-in-95 duration-200">
                            <div className="flex items-start justify-between">
                            <h3 id="new-version-title" className="text-2xl font-bold text-foreground flex items-center gap-3">
                                <div className="p-2 bg-emerald-500/20 rounded-xl border border-emerald-500/30">
                                    <Upload className="w-6 h-6 text-emerald-500" />
                                </div>
                                Publicar Versão de Segurança
                            </h3>
                            <button onClick={() => setShowNewVersionModal(false)} className="text-muted-foreground hover:text-foreground transition-colors p-1 -mt-1 -mr-1">
                                <X className="w-5 h-5" />
                            </button>
                            </div>
                            <p className="text-sm text-muted-foreground font-medium">As novas políticas entrarão em modo rascunho e exigem homologação HITL.</p>

                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-xs font-bold uppercase text-muted-foreground">Selecionar Assistente</label>
                                    <select
                                        value={versionData.assistantId}
                                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVersionData(v => ({ ...v, assistantId: e.target.value }))}
                                        className="w-full bg-secondary border border-border rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                                    >
                                        <option value="">Selecione um assistente alvo...</option>
                                        {assistants.map((a: Assistant) => <option key={a.id} value={a.id}>{a.name} ({a.status})</option>)}
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-bold uppercase text-muted-foreground">Nova Política (JSON OPA/DLP)</label>
                                    <textarea
                                        value={versionData.policyJson}
                                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setVersionData(v => ({ ...v, policyJson: e.target.value }))}
                                        rows={8}
                                        className="w-full bg-secondary border border-border rounded-lg px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-ring resize-none"
                                        placeholder='{ "rules": [...] }'
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold uppercase text-muted-foreground">Tipo de Mudança (Semver)</label>
                                        <select
                                            value={versionData.changeType}
                                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVersionData(v => ({ ...v, changeType: e.target.value as 'major' | 'minor' | 'patch' }))}
                                            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                                        >
                                            <option value="patch">patch — correção / ajuste</option>
                                            <option value="minor">minor — nova funcionalidade</option>
                                            <option value="major">major — breaking change</option>
                                        </select>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold uppercase text-muted-foreground">Changelog (opcional)</label>
                                        <input
                                            type="text"
                                            value={versionData.changelog}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVersionData(v => ({ ...v, changelog: e.target.value }))}
                                            placeholder="Descreva a mudança..."
                                            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-4 border-t border-border">
                                <button onClick={() => setShowNewVersionModal(false)}
                                    className="px-4 py-2 text-sm font-medium hover:bg-secondary rounded-lg transition-colors">
                                    Cancelar
                                </button>
                                <button onClick={handleNewVersion} disabled={publishing || !versionData.assistantId}
                                    className="px-6 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50">
                                    {publishing ? 'Publicando...' : 'Publicar Agora'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Homologation Modal */}
                {publishModalAst && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="homolog-title"
                        onClick={(e) => { if (e.target === e.currentTarget) setPublishModalAst(null); }}
                    >
                        <div className="bg-card w-full max-w-lg rounded-2xl p-6 shadow-2xl border border-border">
                            <div className="flex items-center justify-between mb-2">
                            <h3 id="homolog-title" className="text-xl font-bold">Homologação de Agente</h3>
                            <button onClick={() => setPublishModalAst(null)} className="text-muted-foreground hover:text-foreground transition-colors p-1">
                                <X className="w-5 h-5" />
                            </button>
                            </div>
                            <p className="text-sm text-muted-foreground mb-6">
                                Você está publicando o agente <strong className="text-foreground">{publishModalAst.name}</strong>. Assine o Termo de Ajustamento de Conduta confirmando as validações abaixo.
                            </p>

                            <div className="space-y-4 mb-8">
                                <label className="flex items-start gap-3 cursor-pointer">
                                    <input type="checkbox" checked={checklist.data_privacy} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setChecklist(c => ({ ...c, data_privacy: e.target.checked }))} className="mt-1" />
                                    <span className="text-sm">Confirmo que as configurações de DLP e PII (LGPD Art. 46) estão ativadas e configuradas adequadamente para o grau de sigilo das informações que o assistente terá acesso.</span>
                                </label>
                                <label className="flex items-start gap-3 cursor-pointer">
                                    <input type="checkbox" checked={checklist.injection_mitigation} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setChecklist(c => ({ ...c, injection_mitigation: e.target.checked }))} className="mt-1" />
                                    <span className="text-sm">Validei as mitigações contra Prompt Injection e entendo que nenhum dado restrito pode ser forçado para extração por técnicas de jailbreak.</span>
                                </label>
                                <label className="flex items-start gap-3 cursor-pointer">
                                    <input type="checkbox" checked={checklist.legal_review} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setChecklist(c => ({ ...c, legal_review: e.target.checked }))} className="mt-1" />
                                    <span className="text-sm">Esta versão foi submetida a revisão do DPO/DSO jurídico, liberando para operação corporativa em conformidade com as diretrizes e responsabilidades da Lei n° 13.709/2018.</span>
                                </label>
                            </div>

                            <div className="flex justify-end gap-3">
                                <button onClick={() => setPublishModalAst(null)} disabled={publishing}
                                    className="px-4 py-2 text-sm font-medium hover:bg-secondary rounded-lg transition-colors">
                                    Cancelar
                                </button>
                                <button onClick={handlePublish} disabled={publishing || !Object.values(checklist).every(Boolean)}
                                    className="px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
                                    <CheckCircle2 className="w-4 h-4" /> {publishing ? 'Assinando...' : 'Assinar e Publicar'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* FASE 5d — Delegation Config Modal */}
                {delegationAst && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                        <div className="w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
                            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                                <div className="flex items-center gap-2">
                                    <Workflow className="w-5 h-5 text-violet-400" />
                                    <h2 className="text-lg font-semibold text-foreground">Delegação Autônoma</h2>
                                </div>
                                <button onClick={() => setDelegationAst(null)} className="text-muted-foreground hover:text-foreground transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            <div className="flex-1 overflow-y-auto p-6 space-y-5">
                                <div>
                                    <p className="text-sm text-muted-foreground mb-1">Assistente</p>
                                    <p className="text-sm font-medium text-foreground">{delegationAst.name}</p>
                                </div>

                                {loadingDelegation ? (
                                    <div className="h-32 bg-secondary/20 rounded-lg animate-pulse" />
                                ) : (
                                    <>
                                        <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-4">
                                            <p className="text-xs text-violet-300/80 leading-relaxed">
                                                Quando habilitado, mensagens que matchem um dos padrões regex serão escaladas
                                                para o <strong>Architect → OpenClaude</strong> em vez de chamar o LLM diretamente.
                                                A execução roda autonomamente e o resultado fica em <code className="text-[11px] bg-violet-500/10 px-1 rounded">/architect</code>.
                                            </p>
                                        </div>

                                        <div className="flex items-center justify-between">
                                            <div>
                                                <label className="block text-sm font-medium text-foreground">Habilitar delegação</label>
                                                <p className="text-xs text-muted-foreground mt-0.5">Necessário para que padrões sejam avaliados</p>
                                            </div>
                                            <button
                                                onClick={() => setDelegationConfig(c => ({ ...c, enabled: !c.enabled }))}
                                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                                    delegationConfig.enabled ? 'bg-violet-500' : 'bg-secondary'
                                                }`}
                                            >
                                                <span
                                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                                        delegationConfig.enabled ? 'translate-x-6' : 'translate-x-1'
                                                    }`}
                                                />
                                            </button>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-foreground mb-1">
                                                Padrões de delegação (regex, um por linha)
                                            </label>
                                            <textarea
                                                value={delegationPatternsRaw}
                                                onChange={e => setDelegationPatternsRaw(e.target.value)}
                                                rows={6}
                                                placeholder={`analise o (repositório|código|projeto)\ngere um relatório\nexecute os testes`}
                                                className="w-full bg-secondary border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                            />
                                            <p className="text-[10px] text-muted-foreground mt-1">
                                                Match case-insensitive. Cada linha é uma RegExp JavaScript válida.
                                            </p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-foreground mb-1">
                                                Timeout máximo (segundos)
                                            </label>
                                            <input
                                                type="number"
                                                min={10}
                                                max={3600}
                                                value={delegationConfig.max_duration_seconds}
                                                onChange={e => setDelegationConfig(c => ({
                                                    ...c,
                                                    max_duration_seconds: Math.max(10, Math.min(3600, parseInt(e.target.value) || 300)),
                                                }))}
                                                className="w-32 bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                            />
                                            <p className="text-[10px] text-muted-foreground mt-1">
                                                Tempo máximo para execução do OpenClaude. Padrão: 300s (5 min).
                                            </p>
                                        </div>

                                        {/* FASE 7 — Runtime preference selector */}
                                        {runtimeOptions.length > 0 && (
                                            <div>
                                                <label className="block text-sm font-medium text-foreground mb-1">
                                                    Runtime preferido
                                                </label>
                                                <select
                                                    value={delegationRuntimeSlug}
                                                    onChange={e => setDelegationRuntimeSlug(e.target.value)}
                                                    className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                >
                                                    {runtimeOptions.map(rt => {
                                                        // FASE 13.5b.1: centralized labels
                                                        // so all runtimes (incl. Aider)
                                                        // render consistently with the
                                                        // playground selector.
                                                        const icon = runtimeClassIcon(rt.runtime_class);
                                                        const suffix = rt.available ? '' : ' — indisponível';
                                                        const claim = claimLevelLabel(rt.claim_level);
                                                        return (
                                                            <option key={rt.slug} value={rt.slug} disabled={!rt.available}>
                                                                {icon} {rt.display_name} ({claim}){suffix}
                                                            </option>
                                                        );
                                                    })}
                                                </select>
                                                <p className="text-[10px] text-muted-foreground mt-1">
                                                    {delegationRuntimeSlug === 'claude_code_official'
                                                        ? 'Runtime oficial Anthropic. Requer ANTHROPIC_API_KEY com créditos e o container claude-code-runner ativo.'
                                                        : 'Runtime aberto multi-provider. Usa LiteLLM com failover automático (Groq, Cerebras, Gemini, Ollama).'}
                                                </p>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="px-6 py-4 border-t border-border bg-secondary/10 flex items-center justify-end gap-2">
                                <button
                                    onClick={() => setDelegationAst(null)}
                                    className="px-4 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={saveDelegation}
                                    disabled={savingDelegation || loadingDelegation}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 transition-colors disabled:opacity-50"
                                >
                                    {savingDelegation ? 'Salvando...' : 'Salvar'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
