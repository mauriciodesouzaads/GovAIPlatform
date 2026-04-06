'use client';

import { useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { Key, Copy, Trash2, Plus, ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/Toast';

function Skeleton({ className }: { className?: string }) {
    return <div className={`animate-pulse bg-secondary rounded ${className ?? 'h-4 w-full'}`} />;
}

interface ApiKey {
    id: string;
    name: string;
    prefix: string;
    is_active: boolean;
    created_at: string;
}

export default function ApiKeysPage() {
    const { toast } = useToast();
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [newKeyName, setNewKeyName] = useState('');
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [copied, setCopied] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

    const fetchKeys = async () => {
        setError(null);
        try {
            const res = await api.get(ENDPOINTS.API_KEYS);
            setKeys(res.data);
        } catch (e) {
            console.error(e);
            setError('Não foi possível carregar as chaves de API.');
        } finally { setLoading(false); }
    };

    useEffect(() => { fetchKeys(); }, []);

    const createKey = async () => {
        if (!newKeyName) return;
        setCreating(true);
        setCopied(false);
        try {
            const res = await api.post(ENDPOINTS.API_KEYS, { name: newKeyName });
            setCreatedKey(res.data.key);
            setNewKeyName('');
            fetchKeys();
        } catch (e) {
            console.error(e);
            toast('Erro ao criar chave de API.', 'error');
        } finally { setCreating(false); }
    };

    const revokeKey = async (keyId: string) => {
        try {
            await api.delete(`${ENDPOINTS.API_KEYS}/${keyId}`);
            setConfirmRevoke(null);
            fetchKeys();
        } catch (e) {
            console.error(e);
            toast('Erro ao revogar chave de API.', 'error');
        }
    };

    const handleCopy = () => {
        if (createdKey) {
            navigator.clipboard.writeText(createdKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-5xl mx-auto p-6 space-y-8">
                <div>
                    <h2 className="text-3xl font-black tracking-tight flex items-center gap-3 bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-emerald-600">
                        <Key className="w-8 h-8 text-emerald-500" />
                        API Keys
                    </h2>
                    <p className="text-muted-foreground mt-2 font-medium">Gere e gerencie chaves de acesso para consumo seguro da API GovAI. <br />As chaves assinadas garantem o rastreamento em auditorias.</p>
                </div>

                {/* Create New Key */}
                <div className="bg-card border border-border rounded-xl p-6 shadow-sm space-y-6 relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-bl-[100px] pointer-events-none group-hover:bg-emerald-500/10 transition-colors duration-500" />

                    <div className="relative z-10">
                        <h3 className="font-bold text-lg flex items-center gap-2 mb-4">
                            <Plus className="w-5 h-5 text-emerald-500" />
                            Gerar Nova Chave
                        </h3>
                        <div className="flex gap-4 items-center">
                            <input
                                type="text"
                                value={newKeyName}
                                onChange={(e) => setNewKeyName(e.target.value)}
                                placeholder="Nome para identificação (ex: Produção Gateway AWS)"
                                className="flex-1 bg-secondary/50 border border-border/50 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all placeholder:text-muted-foreground shadow-inner"
                            />
                            <button
                                onClick={createKey}
                                disabled={creating || !newKeyName}
                                className="bg-emerald-500 text-black font-bold text-sm px-6 py-3 rounded-lg hover:bg-emerald-400 transition-all disabled:opacity-50 disabled:hover:bg-emerald-500 flex items-center gap-2 shadow-lg shadow-emerald-500/20"
                            >
                                {creating ? <span className="animate-spin text-lg leading-none mb-1">⟳</span> : <Plus className="w-4 h-4" />}
                                Gerar Key
                            </button>
                        </div>
                    </div>

                    {createdKey && (
                        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-5 mt-6 relative z-10 animate-in fade-in slide-in-from-top-4 duration-300">
                            <div className="flex items-center gap-2 text-emerald-500 text-sm font-bold mb-3 uppercase tracking-wider">
                                <ShieldCheck className="w-5 h-5" /> Chave Mestra Criada com Sucesso
                            </div>
                            <div className="flex items-center gap-3">
                                <code className="bg-background border border-border px-4 py-3 rounded-lg font-mono text-sm flex-1 select-all text-emerald-400 shadow-inner">
                                    {createdKey}
                                </code>
                                <button
                                    onClick={handleCopy}
                                    className={`p-3 rounded-lg transition-all duration-300 flex items-center justify-center min-w-[48px] ${copied ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/20' : 'bg-secondary border border-border hover:bg-secondary/80 text-foreground'}`}
                                    title="Copiar"
                                >
                                    {copied ? <CheckCircle2 className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                                </button>
                            </div>
                            <p className="text-xs text-emerald-500/80 mt-3 font-medium bg-emerald-500/5 inline-block px-3 py-1.5 rounded-md">
                                ⚠️ Guarde esta chave em segurança (ex: AWS Secrets Manager). Por motivos de segurança, ela não será exibida novamente.
                            </p>
                        </div>
                    )}
                </div>

                {/* Keys List */}
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-6 py-4 border-b border-border/50 bg-secondary/20">
                        <h3 className="font-bold text-lg flex items-center gap-2">
                            <ShieldCheck className="w-5 h-5 text-indigo-400" />
                            Chaves de Acesso Ativas
                        </h3>
                    </div>
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground bg-secondary/30 uppercase tracking-wider">
                            <tr>
                                <th className="px-6 py-4 font-semibold">Nome da Chave</th>
                                <th className="px-6 py-4 font-semibold">Prefixo / Identificador</th>
                                <th className="px-6 py-4 font-semibold text-center">Status</th>
                                <th className="px-6 py-4 font-semibold text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                            {loading ? (
                                <>
                                    {[1,2,3].map(i => (
                                        <tr key={i}><td colSpan={4} className="px-6 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                                    ))}
                                </>
                            ) : error ? (
                                <tr><td colSpan={4} className="px-6 py-12 text-center">
                                    <div className="flex flex-col items-center gap-3">
                                        <AlertTriangle className="w-8 h-8 text-destructive/70" />
                                        <p className="text-sm text-destructive font-medium">{error}</p>
                                        <button onClick={fetchKeys} className="text-xs text-muted-foreground underline hover:text-foreground transition-colors">Tentar novamente</button>
                                    </div>
                                </td></tr>
                            ) : keys.length === 0 ? (
                                <tr><td colSpan={4} className="px-6 py-12 text-center text-muted-foreground font-medium">Nenhuma chave gerada na organização.</td></tr>
                            ) : (
                                keys.map(k => (
                                    <tr key={k.id} className="hover:bg-secondary/20 transition-colors group">
                                        <td className="px-6 py-4 font-semibold text-foreground flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-indigo-500" />
                                            {k.name}
                                        </td>
                                        <td className="px-6 py-4 font-mono text-xs text-muted-foreground bg-background/50 my-2 mx-6 rounded-md px-3 py-1.5 inline-block border border-border/50">
                                            {k.prefix}...<span className="opacity-50">****</span>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${k.is_active ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-destructive/10 text-destructive border border-destructive/20'}`}>
                                                {k.is_active && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                                                {!k.is_active && <span className="w-1.5 h-1.5 rounded-full bg-destructive" />}
                                                {k.is_active ? 'Ativa' : 'Revogada'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            {k.is_active ? (
                                                confirmRevoke === k.id ? (
                                                    <div className="flex items-center justify-end gap-2">
                                                        <span className="text-xs text-muted-foreground">Confirmar?</span>
                                                        <button
                                                            onClick={() => revokeKey(k.id)}
                                                            className="px-2 py-1 rounded text-xs font-semibold bg-destructive text-foreground hover:bg-destructive/80 transition-colors"
                                                        >
                                                            Revogar
                                                        </button>
                                                        <button
                                                            onClick={() => setConfirmRevoke(null)}
                                                            className="px-2 py-1 rounded text-xs font-semibold border border-border text-muted-foreground hover:text-foreground transition-colors"
                                                        >
                                                            Cancelar
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => setConfirmRevoke(k.id)}
                                                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors text-xs font-semibold"
                                                    >
                                                        <Trash2 className="w-4 h-4" /> Revogar
                                                    </button>
                                                )
                                            ) : (
                                                <span className="text-xs text-muted-foreground/50 font-medium">Inativa</span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
