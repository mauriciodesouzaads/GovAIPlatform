'use client';

import { useState, useEffect, useCallback } from 'react';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import api, { ENDPOINTS } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/Toast';
import { Building2, Plus, UserPlus, Pencil, X, Users, Bot, Clock, Calendar, Lock } from 'lucide-react';
import { SkeletonTable } from '@/components/Skeleton';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/Badge';

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

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    useEscapeClose(onClose);
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl">
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <h2 className="text-base font-semibold text-foreground">{title}</h2>
                    <button onClick={onClose} className="text-foreground/40 hover:text-foreground transition-colors">
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
            <label className="text-xs font-medium text-foreground/60 uppercase tracking-wider">{label}</label>
            {children}
        </div>
    );
}

const inputCls = "w-full px-3 py-2.5 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-colors";

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
                        className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm text-foreground/60 hover:text-foreground hover:border-border transition-colors">
                        Cancelar
                    </button>
                    <button type="submit" disabled={loading}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-foreground transition-colors">
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
                        className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm text-foreground/60 hover:text-foreground hover:border-border transition-colors">
                        Cancelar
                    </button>
                    <button type="submit" disabled={loading}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-foreground transition-colors">
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
                        className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm text-foreground/60 hover:text-foreground hover:border-border transition-colors">
                        Cancelar
                    </button>
                    <button type="submit" disabled={loading}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-foreground transition-colors">
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
    const { toast } = useToast();
    const [orgs, setOrgs] = useState<OrgRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [inviteOrg, setInviteOrg] = useState<OrgRow | null>(null);
    const [editOrg, setEditOrg] = useState<OrgRow | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.PLATFORM_ORGS);
            setOrgs(res.data as OrgRow[]);
        } catch {
            toast('Erro ao carregar organizações.', 'error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    function showSuccess(msg: string) {
        toast(msg, 'success');
        load();
    }

    // 6c.B.3 CP1.D-B: banner explicativo p/ não-platform_admin (em vez de
    // mensagem fria 'Acesso restrito'). Indica feature em desenvolvimento +
    // aponta caminhos alternativos: /settings (org admin) e /consultant
    // (multi-tenant readonly se houver permissão).
    if (role !== 'platform_admin') {
        return (
            <div className="flex-1 overflow-auto">
                <div className="max-w-3xl mx-auto p-4 sm:p-6">
                    <PageHeader
                        title="Organizações"
                        subtitle="Gestão multi-tenant — recurso de plataforma"
                        icon={<Building2 className="w-5 h-5" />}
                    />
                    <div className="mt-4 rounded-xl border border-border bg-card p-6">
                        <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-violet-500/10 text-violet-400 flex items-center justify-center">
                                <Lock className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <h2 className="text-base font-semibold text-foreground">
                                        Recurso de Plataforma
                                    </h2>
                                    <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-violet-500/10 text-violet-400 border border-violet-500/30">
                                        Beta
                                    </span>
                                </div>
                                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                                    A gestão de organizações está disponível apenas para administradores
                                    da plataforma GovAI. Como administrador desta organização, você tem
                                    acesso completo às configurações em{' '}
                                    <a href="/settings" className="text-primary hover:underline">
                                        Configurações
                                    </a>
                                    {' '}e ao{' '}
                                    <a href="/consultant" className="text-primary hover:underline">
                                        Painel do Consultor
                                    </a>
                                    {' '}(somente leitura) caso tenha permissão de consultoria multi-tenant.
                                </p>
                                <p className="text-xs text-muted-foreground/70 mt-3">
                                    Recurso em desenvolvimento — disponível em release futuro para
                                    Platform Admins do GovAI SaaS.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
                <PageHeader
                    title="Organizações"
                    subtitle="Gerenciamento de tenants"
                    icon={<Building2 className="w-5 h-5" />}
                />

                {/* Stats row */}
                <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-3 gap-4 mb-8">
                    {loading ? (
                        [1,2,3].map(i => (
                            <div key={i} className="bg-card border border-border rounded-2xl p-5 flex items-center gap-4">
                                <div className="w-10 h-10 rounded-xl bg-secondary/60 animate-pulse shrink-0" />
                                <div className="flex-1 space-y-2"><div className="h-6 bg-secondary/60 rounded animate-pulse w-1/2" /><div className="h-3 bg-secondary/60 rounded animate-pulse w-3/4" /></div>
                            </div>
                        ))
                    ) : [
                        { label: 'Total de orgs', value: orgs.length, icon: Building2, color: 'indigo' },
                        { label: 'Total de usuários', value: orgs.reduce((s, o) => s + (o.user_count ?? 0), 0), icon: Users, color: 'emerald' },
                        { label: 'Total de assistentes', value: orgs.reduce((s, o) => s + (o.assistant_count ?? 0), 0), icon: Bot, color: 'amber' },
                    ].map(({ label, value, icon: Icon, color }) => (
                        <div key={label} className="bg-card border border-border rounded-2xl p-5 flex items-center gap-4">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center
                                ${color === 'indigo' ? 'bg-indigo-500/15 text-indigo-400' : color === 'emerald' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                                <Icon className="w-5 h-5" />
                            </div>
                            <div>
                                <div className="text-2xl font-bold text-foreground">{value}</div>
                                <div className="text-xs text-foreground/40">{label}</div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Table */}
                <div className="bg-card border border-border rounded-2xl overflow-hidden">
                    <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-foreground">Tenants ativos</h2>
                        <span className="text-xs text-foreground/30">{orgs.length} organizações</span>
                    </div>

                    {loading ? (
                        <SkeletonTable rows={4} cols={7} />
                    ) : orgs.length === 0 ? (
                        <div className="px-6 py-12 text-center">
                            <Building2 className="w-8 h-8 text-foreground/15 mx-auto mb-3" />
                            <p className="text-foreground/30 text-sm">Nenhuma organização cadastrada.</p>
                            <p className="text-foreground/20 text-xs mt-1">Clique em "Nova Organização" para começar.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border">
                                        {[
                                            { label: 'Nome', cls: '' },
                                            { label: 'Admin Email', cls: 'hidden sm:table-cell' },
                                            { label: 'Usuários', cls: 'hidden md:table-cell' },
                                            { label: 'Assistentes', cls: 'hidden md:table-cell' },
                                            { label: 'HITL Timeout', cls: 'hidden lg:table-cell' },
                                            { label: 'Criado em', cls: 'hidden lg:table-cell' },
                                            { label: 'Ações', cls: '' },
                                        ].map(({ label, cls }) => (
                                            <th key={label} className={`px-5 py-3 text-left text-xs font-semibold text-foreground/40 uppercase tracking-wider whitespace-nowrap ${cls}`}>
                                                {label}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {orgs.map((org, i) => (
                                        <tr key={org.id}
                                            className={`border-b border-border/50 hover:bg-secondary/20 transition-colors ${i === orgs.length - 1 ? 'border-b-0' : ''}`}>
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-7 h-7 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center text-xs font-bold uppercase ring-1 ring-indigo-500/20">
                                                        {org.name.charAt(0)}
                                                    </div>
                                                    <span className="font-medium text-foreground">{org.name}</span>
                                                </div>
                                            </td>
                                            <td className="hidden sm:table-cell px-5 py-4 text-foreground/60 max-w-[180px] truncate" title={org.admin_email ?? ''}>
                                                {org.admin_email ?? <span className="text-foreground/25 italic">—</span>}
                                            </td>
                                            <td className="hidden md:table-cell px-5 py-4">
                                                <div className="flex items-center gap-1.5 text-foreground/60">
                                                    <Users className="w-3.5 h-3.5 text-foreground/30" />
                                                    {org.user_count ?? 0}
                                                </div>
                                            </td>
                                            <td className="hidden md:table-cell px-5 py-4">
                                                <div className="flex items-center gap-1.5 text-foreground/60">
                                                    <Bot className="w-3.5 h-3.5 text-foreground/30" />
                                                    {org.assistant_count ?? 0}
                                                </div>
                                            </td>
                                            <td className="hidden lg:table-cell px-5 py-4">
                                                <div className="flex items-center gap-1.5 text-foreground/60">
                                                    <Clock className="w-3.5 h-3.5 text-foreground/30" />
                                                    {org.hitl_timeout_hours ?? 4}h
                                                </div>
                                            </td>
                                            <td className="hidden lg:table-cell px-5 py-4 text-foreground/40 whitespace-nowrap">
                                                <div className="flex items-center gap-1.5">
                                                    <Calendar className="w-3.5 h-3.5 text-foreground/25" />
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
                                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 text-foreground/50 hover:bg-secondary/70 hover:text-foreground text-xs font-medium transition-colors border border-border"
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

        </div>
    );
}
