'use client';

import { useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { Key, Copy, Trash2, Plus, ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/Badge';

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
        } catch {
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
        } catch {
            toast('Erro ao criar chave de API.', 'error');
        } finally { setCreating(false); }
    };

    const revokeKey = async (keyId: string) => {
        try {
            await api.delete(`${ENDPOINTS.API_KEYS}/${keyId}`);
            setConfirmRevoke(null);
            fetchKeys();
        } catch {
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
            <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
                <PageHeader
                    title="API Keys"
                    subtitle="Chaves de acesso à plataforma"
                    icon={<Key className="w-5 h-5" />}
                />

                {/* Create New Key */}
                <div className="bg-card border border-border rounded-xl p-5 space-y-5">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                        <Plus className="w-4 h-4 text-primary" />
                        Gerar Nova Chave
                    </h3>
                    <div className="flex flex-col sm:flex-row gap-3">
                        <input
                            type="text"
                            value={newKeyName}
                            onChange={(e) => setNewKeyName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') createKey(); }}
                            placeholder="Nome para identificação (ex: Produção Gateway AWS)"
                            className="flex-1 bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background transition-all placeholder:text-muted-foreground"
                        />
                        <button
                            onClick={createKey}
                            disabled={creating || !newKeyName}
                            className="bg-primary text-primary-foreground font-semibold text-sm px-5 py-2.5 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 shrink-0"
                        >
                            {creating ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <Plus className="w-4 h-4" />}
                            Gerar Key
                        </button>
                    </div>

                    {createdKey && (
                        <div className="bg-success-bg border border-emerald-500/20 rounded-xl p-4 space-y-3 animate-in fade-in duration-300">
                            <div className="flex items-center gap-2 text-success-fg text-xs font-semibold uppercase tracking-wider">
                                <ShieldCheck className="w-4 h-4" /> Chave criada com sucesso
                            </div>
                            <div className="flex items-center gap-3">
                                <code className="bg-background border border-border px-4 py-2.5 rounded-lg font-mono text-sm flex-1 select-all text-success-fg">
                                    {createdKey}
                                </code>
                                <button
                                    onClick={handleCopy}
                                    className={`p-2.5 rounded-lg transition-colors flex items-center justify-center ${copied ? 'bg-emerald-500 text-primary-foreground' : 'bg-secondary border border-border hover:bg-secondary/80 text-foreground'}`}
                                    title="Copiar"
                                >
                                    {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </button>
                            </div>
                            <p className="text-xs text-success-fg font-medium">
                                Guarde esta chave em segurança. Por motivos de segurança, ela não será exibida novamente.
                            </p>
                        </div>
                    )}
                </div>

                {/* Keys List */}
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-border bg-secondary/20">
                        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                            <ShieldCheck className="w-4 h-4 text-indigo-400" />
                            Chaves de Acesso Ativas
                        </h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead>
                                <tr className="border-b border-border bg-secondary/40">
                                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Nome</th>
                                    <th className="hidden sm:table-cell px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Prefixo</th>
                                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center">Status</th>
                                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    Array.from({ length: 3 }).map((_, i) => (
                                        <tr key={i} className="border-b border-border/50">
                                            <td className="px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse" /></td>
                                            <td className="hidden sm:table-cell px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-24" /></td>
                                            <td className="px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-16 mx-auto" /></td>
                                            <td className="px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-12 ml-auto" /></td>
                                        </tr>
                                    ))
                                ) : error ? (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-10 text-center">
                                            <div className="flex flex-col items-center gap-3">
                                                <AlertTriangle className="w-7 h-7 text-destructive/70" />
                                                <p className="text-sm text-destructive">{error}</p>
                                                <button onClick={fetchKeys} className="text-xs text-muted-foreground underline hover:text-foreground transition-colors">Tentar novamente</button>
                                            </div>
                                        </td>
                                    </tr>
                                ) : keys.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                                            Nenhuma chave gerada na organização.
                                        </td>
                                    </tr>
                                ) : (
                                    keys.map(k => (
                                        <tr key={k.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/30 transition-colors">
                                            <td className="px-4 py-3 font-medium text-foreground max-w-[160px] sm:max-w-none truncate">{k.name}</td>
                                            <td className="hidden sm:table-cell px-4 py-3">
                                                <code className="font-mono text-xs text-muted-foreground bg-secondary/50 border border-border/50 px-2 py-1 rounded">
                                                    {k.prefix}…****
                                                </code>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <Badge variant={k.is_active ? 'success' : 'error'} dot>
                                                    {k.is_active ? 'Ativa' : 'Revogada'}
                                                </Badge>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                {k.is_active ? (
                                                    confirmRevoke === k.id ? (
                                                        <div className="flex items-center justify-end gap-2">
                                                            <span className="hidden sm:inline text-xs text-muted-foreground">Confirmar?</span>
                                                            <button onClick={() => revokeKey(k.id)} className="px-2 py-1 rounded text-xs font-semibold bg-destructive text-white hover:bg-destructive/80 transition-colors">
                                                                Revogar
                                                            </button>
                                                            <button onClick={() => setConfirmRevoke(null)} className="px-2 py-1 rounded text-xs font-semibold border border-border text-muted-foreground hover:text-foreground transition-colors">
                                                                Cancelar
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => setConfirmRevoke(k.id)}
                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-rose-400/70 hover:text-danger-fg hover:bg-danger-bg transition-colors text-xs font-semibold"
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                            <span className="hidden sm:inline">Revogar</span>
                                                        </button>
                                                    )
                                                ) : (
                                                    <span className="text-xs text-muted-foreground/50">Inativa</span>
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
