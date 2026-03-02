'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { Key, Copy, Trash2, Plus, ShieldCheck } from 'lucide-react';
import { API_BASE } from '@/lib/api';

interface ApiKey {
    id: string;
    name: string;
    prefix: string;
    is_active: boolean;
    created_at: string;
}

export default function ApiKeysPage() {
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [loading, setLoading] = useState(true);
    const [newKeyName, setNewKeyName] = useState('');
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);




    const fetchKeys = async () => {
        try {
            const res = await axios.get(`${API_BASE}/v1/admin/api-keys`);
            setKeys(res.data);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchKeys(); }, []);

    const createKey = async () => {
        if (!newKeyName) return;
        setCreating(true);
        try {
            const res = await axios.post(`${API_BASE}/v1/admin/api-keys`, { name: newKeyName });
            setCreatedKey(res.data.key);
            setNewKeyName('');
            fetchKeys();
        } catch (e) { console.error(e); }
        finally { setCreating(false); }
    };

    const revokeKey = async (keyId: string) => {
        try {
            await axios.delete(`${API_BASE}/v1/admin/api-keys/${keyId}`);
            fetchKeys();
        } catch (e) { console.error(e); }
    };

    return (
        <div className="flex-1 overflow-auto p-8 bg-background">
            <div className="max-w-4xl mx-auto space-y-8">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                        <Key className="w-7 h-7" /> API Keys
                    </h2>
                    <p className="text-muted-foreground mt-2">Gere e gerencie chaves de acesso para consumo seguro da API GovAI.</p>
                </div>

                {/* Create New Key */}
                <div className="bg-card border border-border rounded-xl p-6 shadow-sm space-y-4">
                    <h3 className="font-semibold">Gerar Nova Chave</h3>
                    <div className="flex gap-3">
                        <input
                            type="text"
                            value={newKeyName}
                            onChange={(e) => setNewKeyName(e.target.value)}
                            placeholder="Nome da chave (ex: Produção Mobile)"
                            className="flex-1 bg-secondary border border-border rounded-md px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <button
                            onClick={createKey}
                            disabled={creating || !newKeyName}
                            className="bg-foreground text-background font-medium text-sm px-5 py-2.5 rounded-md hover:bg-foreground/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                            <Plus className="w-4 h-4" /> Gerar
                        </button>
                    </div>

                    {createdKey && (
                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 mt-4">
                            <div className="flex items-center gap-2 text-green-500 text-sm font-semibold mb-2">
                                <ShieldCheck className="w-4 h-4" /> Chave Criada com Sucesso!
                            </div>
                            <div className="flex items-center gap-2">
                                <code className="bg-secondary px-3 py-2 rounded font-mono text-xs flex-1 select-all">{createdKey}</code>
                                <button
                                    onClick={() => { navigator.clipboard.writeText(createdKey); }}
                                    className="text-muted-foreground hover:text-foreground p-2"
                                    title="Copiar"
                                >
                                    <Copy className="w-4 h-4" />
                                </button>
                            </div>
                            <p className="text-xs text-green-500/70 mt-2">⚠️ Guarde esta chave agora. Ela não será exibida novamente.</p>
                        </div>
                    )}
                </div>

                {/* Keys List */}
                <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground bg-secondary/50 uppercase border-b border-border">
                            <tr>
                                <th className="px-6 py-4 font-medium">Nome</th>
                                <th className="px-6 py-4 font-medium">Prefixo</th>
                                <th className="px-6 py-4 font-medium">Status</th>
                                <th className="px-6 py-4 font-medium text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">Carregando...</td></tr>
                            ) : keys.length === 0 ? (
                                <tr><td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">Nenhuma chave criada.</td></tr>
                            ) : (
                                keys.map(k => (
                                    <tr key={k.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                                        <td className="px-6 py-4 font-medium">{k.name}</td>
                                        <td className="px-6 py-4 font-mono text-xs text-muted-foreground">{k.prefix}...****</td>
                                        <td className="px-6 py-4">
                                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${k.is_active ? 'bg-green-500/10 text-green-500' : 'bg-destructive/10 text-destructive'}`}>
                                                {k.is_active ? 'Ativa' : 'Revogada'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            {k.is_active && (
                                                <button onClick={() => revokeKey(k.id)} className="text-destructive hover:text-destructive/80 text-xs flex items-center gap-1 ml-auto">
                                                    <Trash2 className="w-3.5 h-3.5" /> Revogar
                                                </button>
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
    );
}
