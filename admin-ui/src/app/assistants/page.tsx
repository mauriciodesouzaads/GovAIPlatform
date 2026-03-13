'use client';

import { useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { Plus, Upload, CheckCircle2, Bot, Database, Lock, FileText } from 'lucide-react';
import { useToast } from '@/components/Toast';

interface Assistant { id: string; name: string; status: string; created_at: string; draft_version_id?: string; }
export default function AssistantsPage() {
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
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
    const [versionData, setVersionData] = useState({ assistantId: '', policyJson: '{\n  "version": "1.0",\n  "rules": []\n}' });

    const { toast } = useToast();
    const fetchAssistants = async () => {
        try {
            const res = await api.get(ENDPOINTS.ASSISTANTS);
            setAssistants(res.data);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

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
        // O httpOnly cookie é enviado automaticamente em cada requisição.
        // Não há mais extração manual de cookies aqui.
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
                policy_version_id: selectedPolicyId,
                mcp_server_id: selectedMcpServerId || undefined,
                allowed_tools: tools.length > 0 ? tools : undefined
            });
            setNewName('');
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
        if (!publishModalAst || !publishModalAst.draft_version_id) return;
        setPublishing(true);
        try {
            await api.post(`${ENDPOINTS.ASSISTANTS}/${publishModalAst.id}/versions/${publishModalAst.draft_version_id}/approve`, {
                checklist
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
                policy_json: policy
            });
            toast('Nova versão criada em rascunho! Siga para homologação.', 'success');
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
        <div className="flex-1 overflow-auto p-8 bg-background">
            <div className="max-w-6xl mx-auto space-y-8">
                <div className="flex justify-between items-center">
                    <div>
                        <h2 className="text-3xl font-bold tracking-tight">AI Assistants & RAG</h2>
                        <p className="text-muted-foreground mt-2">Crie agentes e alimente-os com conhecimento proprietário (RAG).</p>
                    </div>
                </div>

                {/* Header Action */}
                <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex justify-between items-center">
                    <div>
                        <h3 className="font-semibold flex items-center gap-2"><Plus className="w-4 h-4" /> Gestão de Assistentes</h3>
                        <p className="text-sm text-muted-foreground">Adicione novos agentes ou publique novas versões de políticas.</p>
                    </div>
                    <div className="flex gap-3">
                        <button onClick={() => setShowNewVersionModal(true)}
                            className="bg-foreground text-background font-medium text-sm px-6 py-2 rounded-md hover:bg-foreground/90 transition-colors flex items-center gap-2">
                            <Upload className="w-4 h-4" /> Publicar Nova Versão
                        </button>
                        <div className="w-px h-8 bg-border" />
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
                    </div>
                </div>

                {/* Assistants Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {loading ? (
                        <div className="col-span-full h-40 bg-secondary rounded-xl animate-pulse" />
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
                                <h3 className="font-bold text-lg text-white group-hover:text-emerald-400 transition-colors">{ast.name}</h3>
                                <p className="text-[10px] text-muted-foreground font-mono mt-1 flex items-center gap-1.5">
                                    <Lock className="w-3 h-3" />
                                    {ast.id}
                                </p>
                                <div className="mt-6 pt-4 border-t border-border/50 flex flex-col gap-2">
                                    <button onClick={() => startRAG(ast.id)}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-white/5 text-white hover:bg-white/10 border border-white/5 transition-all">
                                        <Database className="w-3.5 h-3.5" /> Vetorizar Conhecimento
                                    </button>
                                    {ast.status === 'draft' && ast.draft_version_id && (
                                        <button onClick={() => setPublishModalAst(ast)}
                                            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-emerald-500 text-black hover:bg-emerald-400 transition-all">
                                            <CheckCircle2 className="w-3.5 h-3.5" /> Homologar Versão
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
                    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
                        <div className="bg-[#0a0a0a] w-full max-w-2xl rounded-3xl p-8 shadow-[0_0_50px_-12px_rgba(16,185,129,0.3)] border border-emerald-500/20 space-y-6 animate-in zoom-in-95 duration-200">
                            <h3 className="text-2xl font-black text-white flex items-center gap-3">
                                <div className="p-2 bg-emerald-500/20 rounded-xl border border-emerald-500/30">
                                    <Upload className="w-6 h-6 text-emerald-500" />
                                </div>
                                Publicar Versão de Segurança
                            </h3>
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
                                        rows={10}
                                        className="w-full bg-secondary border border-border rounded-lg px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-ring resize-none"
                                        placeholder='{ "rules": [...] }'
                                    />
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
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                        <div className="bg-card w-full max-w-lg rounded-2xl p-6 shadow-2xl border border-border">
                            <h3 className="text-xl font-bold mb-2">Homologação de Agente</h3>
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
            </div>
        </div>
    );
}
