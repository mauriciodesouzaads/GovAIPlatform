'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { Users, Plus, Upload, Database, FileText, CheckCircle2 } from 'lucide-react';
import { API_BASE } from '@/lib/api';

interface Assistant { id: string; name: string; status: string; created_at: string; }
interface KnowledgeBase { id: string; name: string; created_at: string; }export default function AssistantsPage() {
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    // MCP & Policies State
    const [policyVersions, setPolicyVersions] = useState<any[]>([]);
    const [mcpServers, setMcpServers] = useState<any[]>([]);
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



    const fetchAssistants = async () => {
        try {
            const res = await axios.get(`${API_BASE}/v1/admin/assistants`);
            setAssistants(res.data);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    const fetchSelectables = async () => {
        try {
            const [polRes, mcpRes] = await Promise.all([
                axios.get(`${API_BASE}/v1/admin/policy_versions`),
                axios.get(`${API_BASE}/v1/admin/mcp_servers`)
            ]);
            setPolicyVersions(polRes.data);
            setMcpServers(mcpRes.data);
            if (polRes.data.length > 0) setSelectedPolicyId(polRes.data[0].id);
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        // Intercept SSO JWT Token from HttpOnly cookie bypass
        const cookies = document.cookie.split(';');
        const tokenCookie = cookies.find(c => c.trim().startsWith('token='));
        if (tokenCookie) {
            const token = tokenCookie.split('=')[1];
            if (token) {
                localStorage.setItem('govai_admin_token', token);
                document.cookie = "token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
            }
        }

        fetchAssistants();
        fetchSelectables();
    }, []);

    const createAssistant = async () => {
        if (!newName) return;
        setCreating(true);
        try {
            let tools: string[] = [];
            if (allowedToolsInput) {
                tools = allowedToolsInput.split(',').map(t => t.trim()).filter(t => t);
            }
            await axios.post(`${API_BASE}/v1/admin/assistants`, {
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
            const res = await axios.post(`${API_BASE}/v1/admin/assistants/${assistantId}/knowledge`,
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
            const res = await axios.post(`${API_BASE}/v1/admin/knowledge/${kbId}/documents`,
                { content: docContent, title: docTitle }
            );
            setUploadResult(res.data.message);
            setDocContent('');
            setDocTitle('');
        } catch (e: any) {
            setUploadResult(`Erro: ${e.response?.data?.error || e.message}`);
        }
        finally { setUploading(false); }
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

                {/* Create New Assistant */}
                <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
                    <h3 className="font-semibold mb-4 flex items-center gap-2"><Plus className="w-4 h-4" /> Publicar Nova Versão de Assistente</h3>
                    <div className="flex flex-col gap-4">
                        <div className="flex gap-3">
                            <input
                                type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                                placeholder="Nome do assistente (ex: Análise Jurídica)"
                                className="flex-1 bg-secondary border border-border rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                            <select
                                value={selectedPolicyId} onChange={(e) => setSelectedPolicyId(e.target.value)}
                                className="bg-secondary border border-border rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                                <option value="" disabled>Selecione a Política OPA</option>
                                {policyVersions.map((p: any) => <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>)}
                            </select>
                        </div>
                        <div className="flex gap-3">
                            <select
                                value={selectedMcpServerId} onChange={(e) => setSelectedMcpServerId(e.target.value)}
                                className="flex-1 bg-secondary border border-border rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                                <option value="">Sem Integração Externa (MCP)</option>
                                {mcpServers.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                            {selectedMcpServerId && (
                                <input
                                    type="text" value={allowedToolsInput} onChange={(e) => setAllowedToolsInput(e.target.value)}
                                    placeholder="Alvará de Tools (ex: create_ticket, search_docs)"
                                    className="flex-1 bg-secondary border border-border rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                />
                            )}
                            <button onClick={createAssistant} disabled={creating || !newName}
                                className="bg-foreground text-background font-medium text-sm px-6 py-2 rounded-md hover:bg-foreground/90 transition-colors disabled:opacity-50 flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4" /> Publicar Versão
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
                        assistants.map((ast) => (
                            <div key={ast.id} className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col hover:border-border/80 transition-colors">
                                <div className="flex justify-between items-start mb-4">
                                    <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
                                        <Users className="w-5 h-5 text-blue-500" />
                                    </div>
                                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${ast.status === 'published' ? 'bg-green-500/10 text-green-500' : 'bg-amber-500/10 text-amber-500'}`}>
                                        {ast.status}
                                    </span>
                                </div>
                                <h3 className="font-semibold text-lg">{ast.name}</h3>
                                <p className="text-xs text-muted-foreground font-mono mt-1 truncate">{ast.id}</p>
                                <div className="mt-4 pt-4 border-t border-border">
                                    <button onClick={() => startRAG(ast.id)}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors">
                                        <Database className="w-4 h-4" /> Alimentar com Conhecimento (RAG)
                                    </button>
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

                        <input type="text" value={docTitle} onChange={(e) => setDocTitle(e.target.value)}
                            placeholder="Título do documento (ex: Regulamento Interno 2024)"
                            className="w-full bg-secondary border border-border rounded-md px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <textarea value={docContent} onChange={(e) => setDocContent(e.target.value)}
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
            </div>
        </div>
    );
}
