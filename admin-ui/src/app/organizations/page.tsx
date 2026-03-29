'use client';

import { useState, useEffect, useCallback } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { Building2, Plus, UserPlus, Pencil, X, Users, Bot, Clock, Calendar } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrgRow {
    id: string;
    name: string;
    admin_email: string | null;
    user_count: number;
    assistant_count: number;
    hitl_timeout_hours: number;
    created_at: string;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
    useEffect(() => {
        const t = setTimeout(onClose, 4000);
        return () => clearTimeout(t);
    }, [onClose]);

    return (
        <div className={`fixed top-5 right-5 z-[100] flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium border transition-all
            ${type === 'success'
                ? 'bg-emerald-900/90 text-emerald-300 border-emerald-700/60'
                : 'bg-rose-900/90 text-rose-300 border-rose-700/60'}`}>
            <span>{message}</span>
            <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
    );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl">
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
                    <h2 className="text-base font-semibold text-white">{title}</h2>
                    <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="px-6 py-5">{children}</div>
            </div>
        </div>
    );
}

// ── Field ─────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-white/60 uppercase tracking-wider">{label}</label>
            {children}
        </div>
    );
}

const inputCls = "w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-colors";

// ── Create Org Modal ──────────────────────────────────────────────────────────

function CreateOrgModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (msg: string) => void }) {
    const [name, setName] = useState('');
    const [adminEmail, setAdminEmail] = useState('');
    const [adminPassword, setAdminPassword] = useState('');
    const [hitlHours, setHitlHours] = useState(4);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        if (!name.trim()) return setError('Nome da organização é obrigatório.');
        if (!adminEmail.trim()) return setError('Email do admin é obrigatório.');
        if (adminPassword.length < 12) return setError('Senha deve ter pelo menos 12 caracteres.');
        setLoading(true);
        try {
            await api.post(ENDPOINTS.PLATFORM_ORGS, {
                name: name.trim(),
                admin_email: adminEmail.trim(),
                admin_password: adminPassword,
                hitl_timeout_hours: hitlHours,
            });
            onSuccess(`Organização "${name.trim()}" criada com sucesso.`);
            onClose();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Erro ao criar organização.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal title="Nova Organização" onClose={onClose}>
            <form onSubmit={submit} className="flex flex-col gap-4">
                <Field label="Nome da organização">
                    <input className={inputCls} value={name} onChange={e => setName(e.target.value)}
                        placeholder="Ex: Banco Fictício SA" autoFocus />
                </Field>
                <Field label="Email do admin">
                    <input className={inputCls} type="email" value={adminEmail}
                        onChange={e => setAdminEmail(e.target.value)} placeholder="admin@empresa.com" />
                </Field>
                <Field label="Senha inicial (mín. 12 caracteres)">
                    <input className={inputCls} type="password" value={adminPassword}
                        onChange={e => setAdminPassword(e.target.value)} placeholder="••••••••••••" />
                </Field>
                <Field label="HITL Timeout (horas)">
                    <input className={inputCls} type="number" min={1} max={168} value={hitlHours}
                        onChange={e => setHitlHours(Number(e.target.value))} />
                </Field>
                {error && <p className="text-xs text-rose-400">{error}</p>}
                <div className="flex gap-3 pt-1">
                    <button type="button" onClick={onClose}
                        className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white hover:border-white/20 transition-colors">
                        Cancelar
                    </button>
                    <button type="submit" disabled={loading}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
                        {loading ? 'Criando...' : 'Criar Organização'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Invite Admin Modal ────────────────────────────────────────────────────────

function InviteAdminModal({ org, onClose, onSuccess }: {
    org: OrgRow;
    onClose: () => void;
    onSuccess: (msg: string) => void;
}) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        if (!email.trim()) return setError('Email é obrigatório.');
        if (password.length < 12) return setError('Senha deve ter pelo menos 12 caracteres.');
        setLoading(true);
        try {
            await api.post(ENDPOINTS.PLATFORM_ORG_INVITE(org.id), {
                email: email.trim(),
                password,
            });
            onSuccess(`Admin "${email.trim()}" convidado para ${org.name}.`);
            onClose();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Erro ao convidar admin.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal title={`Convidar Admin — ${org.name}`} onClose={onClose}>
            <form onSubmit={submit} className="flex flex-col gap-4">
                <Field label="Email">
                    <input className={inputCls} type="email" value={email}
                        onChange={e => setEmail(e.target.value)} placeholder="novoadmin@empresa.com" autoFocus />
                </Field>
                <Field label="Senha inicial (mín. 12 caracteres)">
                    <input className={inputCls} type="password" value={password}
                        onChange={e => setPassword(e.target.value)} placeholder="••••••••••••" />
                </Field>
                {error && <p className="text-xs text-rose-400">{error}</p>}
                <div className="flex gap-3 pt-1">
                    <button type="button" onClick={onClose}
                        className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white hover:border-white/20 transition-colors">
                        Cancelar
                    </button>
                    <button type="submit" disabled={loading}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
                        {loading ? 'Convidando...' : 'Convidar Admin'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Edit Org Modal ────────────────────────────────────────────────────────────

function EditOrgModal({ org, onClose, onSuccess }: {
    org: OrgRow;
    onClose: () => void;
    onSuccess: (msg: string) => void;
}) {
    const [name, setName] = useState(org.name);
    const [hitlHours, setHitlHours] = useState(org.hitl_timeout_hours ?? 4);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        if (!name.trim()) return setError('Nome é obrigatório.');
        setLoading(true);
        try {
            await api.patch(ENDPOINTS.PLATFORM_ORG(org.id), {
                name: name.trim(),
                hitl_timeout_hours: hitlHours,
            });
            onSuccess(`Organização "${name.trim()}" atualizada.`);
            onClose();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Erro ao atualizar organização.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal title={`Editar — ${org.name}`} onClose={onClose}>
            <form onSubmit={submit} className="flex flex-col gap-4">
                <Field label="Nome da organização">
                    <input className={inputCls} value={name} onChange={e => setName(e.target.value)} autoFocus />
                </Field>
                <Field label="HITL Timeout (horas, 1–168)">
                    <input className={inputCls} type="number" min={1} max={168} value={hitlHours}
                        onChange={e => setHitlHours(Number(e.target.value))} />
                </Field>
                {error && <p className="text-xs text-rose-400">{error}</p>}
                <div className="flex gap-3 pt-1">
                    <button type="button" onClick={onClose}
                        className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white hover:border-white/20 transition-colors">
                        Cancelar
                    </button>
                    <button type="submit" disabled={loading}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
                        {loading ? 'Salvando...' : 'Salvar'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OrganizationsPage() {
    const { role } = useAuth();
    const [orgs, setOrgs] = useState<OrgRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [inviteOrg, setInviteOrg] = useState<OrgRow | null>(null);
    const [editOrg, setEditOrg] = useState<OrgRow | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.PLATFORM_ORGS);
            setOrgs(res.data as OrgRow[]);
        } catch {
            setToast({ message: 'Erro ao carregar organizações.', type: 'error' });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    function showSuccess(msg: string) {
        setToast({ message: msg, type: 'success' });
        load();
    }

    if (role !== 'platform_admin') {
        return (
            <div className="flex-1 flex items-center justify-center bg-black min-h-screen">
                <div className="text-center space-y-3">
                    <Building2 className="w-12 h-12 text-white/20 mx-auto" />
                    <p className="text-white/50 text-sm">Acesso restrito ao administrador da plataforma.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 bg-black min-h-screen relative overflow-hidden">
            {/* Background grid */}
            <div className="absolute inset-0 opacity-20 pointer-events-none"
                style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px)', backgroundSize: '32px 32px' }} />
            {/* Accent blur */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[300px] bg-indigo-500/8 blur-[100px] pointer-events-none" />

            <div className="relative z-10 p-8 max-w-7xl mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center ring-1 ring-indigo-500/30">
                            <Building2 className="w-5 h-5" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-white tracking-tight">Organizações</h1>
                            <p className="text-sm text-white/40 mt-0.5">Gerenciamento de tenants da plataforma</p>
                        </div>
                    </div>
                    <button
                        onClick={() => setShowCreate(true)}
                        className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-colors shadow-lg shadow-indigo-500/20"
                    >
                        <Plus className="w-4 h-4" />
                        Nova Organização
                    </button>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-3 gap-4 mb-8">
                    {[
                        { label: 'Total de orgs', value: orgs.length, icon: Building2, color: 'indigo' },
                        { label: 'Total de usuários', value: orgs.reduce((s, o) => s + (o.user_count ?? 0), 0), icon: Users, color: 'emerald' },
                        { label: 'Total de assistentes', value: orgs.reduce((s, o) => s + (o.assistant_count ?? 0), 0), icon: Bot, color: 'amber' },
                    ].map(({ label, value, icon: Icon, color }) => (
                        <div key={label} className="bg-[#111] border border-white/10 rounded-2xl p-5 flex items-center gap-4">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center
                                ${color === 'indigo' ? 'bg-indigo-500/15 text-indigo-400' : color === 'emerald' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                                <Icon className="w-5 h-5" />
                            </div>
                            <div>
                                <div className="text-2xl font-bold text-white">{value}</div>
                                <div className="text-xs text-white/40">{label}</div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Table */}
                <div className="bg-[#111] border border-white/10 rounded-2xl overflow-hidden">
                    <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-white">Tenants ativos</h2>
                        <span className="text-xs text-white/30">{orgs.length} organizações</span>
                    </div>

                    {loading ? (
                        <div className="px-6 py-12 text-center text-white/30 text-sm">Carregando...</div>
                    ) : orgs.length === 0 ? (
                        <div className="px-6 py-12 text-center">
                            <Building2 className="w-8 h-8 text-white/15 mx-auto mb-3" />
                            <p className="text-white/30 text-sm">Nenhuma organização cadastrada.</p>
                            <p className="text-white/20 text-xs mt-1">Clique em "Nova Organização" para começar.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-white/10">
                                        {['Nome', 'Admin Email', 'Usuários', 'Assistentes', 'HITL Timeout', 'Criado em', 'Ações'].map(h => (
                                            <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider whitespace-nowrap">
                                                {h}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {orgs.map((org, i) => (
                                        <tr key={org.id}
                                            className={`border-b border-white/[0.06] hover:bg-white/[0.02] transition-colors ${i === orgs.length - 1 ? 'border-b-0' : ''}`}>
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-7 h-7 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center text-xs font-bold uppercase ring-1 ring-indigo-500/20">
                                                        {org.name.charAt(0)}
                                                    </div>
                                                    <span className="font-medium text-white">{org.name}</span>
                                                </div>
                                            </td>
                                            <td className="px-5 py-4 text-white/60 max-w-[180px] truncate" title={org.admin_email ?? ''}>
                                                {org.admin_email ?? <span className="text-white/25 italic">—</span>}
                                            </td>
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-1.5 text-white/60">
                                                    <Users className="w-3.5 h-3.5 text-white/30" />
                                                    {org.user_count ?? 0}
                                                </div>
                                            </td>
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-1.5 text-white/60">
                                                    <Bot className="w-3.5 h-3.5 text-white/30" />
                                                    {org.assistant_count ?? 0}
                                                </div>
                                            </td>
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-1.5 text-white/60">
                                                    <Clock className="w-3.5 h-3.5 text-white/30" />
                                                    {org.hitl_timeout_hours ?? 4}h
                                                </div>
                                            </td>
                                            <td className="px-5 py-4 text-white/40 whitespace-nowrap">
                                                <div className="flex items-center gap-1.5">
                                                    <Calendar className="w-3.5 h-3.5 text-white/25" />
                                                    {new Date(org.created_at).toLocaleDateString('pt-BR')}
                                                </div>
                                            </td>
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => setInviteOrg(org)}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 text-xs font-medium transition-colors border border-indigo-500/20"
                                                        title="Convidar Admin"
                                                    >
                                                        <UserPlus className="w-3.5 h-3.5" />
                                                        Convidar Admin
                                                    </button>
                                                    <button
                                                        onClick={() => setEditOrg(org)}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-white/50 hover:bg-white/10 hover:text-white text-xs font-medium transition-colors border border-white/10"
                                                        title="Editar"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                        Editar
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Modals */}
            {showCreate && (
                <CreateOrgModal onClose={() => setShowCreate(false)} onSuccess={showSuccess} />
            )}
            {inviteOrg && (
                <InviteAdminModal org={inviteOrg} onClose={() => setInviteOrg(null)} onSuccess={showSuccess} />
            )}
            {editOrg && (
                <EditOrgModal org={editOrg} onClose={() => setEditOrg(null)} onSuccess={showSuccess} />
            )}

            {/* Toast */}
            {toast && (
                <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
            )}
        </div>
    );
}
