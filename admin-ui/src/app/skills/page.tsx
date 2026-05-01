'use client';

import { useCallback, useEffect, useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { SkeletonCard } from '@/components/Skeleton';
import {
    Sparkles, Plus, Trash2, Edit3, X, Save, AlertCircle,
    Tag, Lock, FileText,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface CatalogSkill {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    instructions: string;
    resources: Record<string, unknown>;
    tags: string[];
    version: string;
    is_active: boolean;
    is_system: boolean;
    created_by: string | null;
    created_at: string;
    updated_at: string;
}

const CATEGORY_COLORS: Record<string, string> = {
    analysis:   'text-info-fg bg-info-bg border-info-border',
    generation: 'text-success-fg bg-success-bg border-success-border',
    review:     'text-violet-400 bg-violet-500/10 border-violet-500/20',
    data:       'text-warning-fg bg-warning-bg border-warning-border',
    automation: 'text-muted-foreground bg-secondary/30 border-border/40',
};

const CATEGORY_OPTIONS = ['analysis', 'generation', 'review', 'data', 'automation'];

// ── Add/Edit Modal ─────────────────────────────────────────────────────────

function SkillModal({
    skill, onClose, onSaved,
}: {
    skill: CatalogSkill | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [name, setName]                 = useState(skill?.name || '');
    const [description, setDescription]   = useState(skill?.description || '');
    const [category, setCategory]         = useState(skill?.category || 'automation');
    const [instructions, setInstructions] = useState(skill?.instructions || '');
    const [tagsRaw, setTagsRaw]           = useState((skill?.tags || []).join(', '));
    const [version, setVersion]           = useState(skill?.version || '1.0');
    const [saving, setSaving]             = useState(false);
    const [error, setError]               = useState('');
    const isEdit  = skill !== null;
    const isSystem = skill?.is_system === true;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSaving(true);
        try {
            const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
            const payload: Record<string, unknown> = {
                instructions,
                tags,
            };
            if (!isSystem) {
                payload.name = name;
                payload.description = description;
                payload.category = category;
                payload.version = version;
            }

            if (isEdit && skill) {
                await api.put(ENDPOINTS.CATALOG_SKILL(skill.id), payload);
            } else {
                payload.name = name;
                payload.description = description;
                payload.category = category;
                payload.version = version;
                await api.post(ENDPOINTS.CATALOG_SKILLS, payload);
            }
            onSaved();
            onClose();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Erro ao salvar.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-violet-400" />
                        <h2 className="text-lg font-semibold text-foreground">
                            {isEdit ? 'Editar Skill' : 'Nova Skill'}
                        </h2>
                        {isSystem && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-warning-bg text-warning-fg border border-warning-border">
                                <Lock className="w-3 h-3" /> sistema
                            </span>
                        )}
                    </div>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
                    <div className="p-6 space-y-4">
                        {isSystem && (
                            <div className="text-xs text-muted-foreground bg-amber-500/5 border border-warning-border rounded px-3 py-2">
                                Skills do sistema têm metadados imutáveis. Você pode atualizar instructions e tags.
                            </div>
                        )}

                        <div>
                            <label className="block text-xs font-medium text-foreground mb-1">Nome *</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                disabled={isSystem}
                                required
                                placeholder="Análise Jurídica"
                                className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50 disabled:opacity-50"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-foreground mb-1">Descrição</label>
                            <input
                                type="text"
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                disabled={isSystem}
                                placeholder="Breve descrição da skill"
                                className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50 disabled:opacity-50"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-medium text-foreground mb-1">Categoria</label>
                                <select
                                    value={category}
                                    onChange={e => setCategory(e.target.value)}
                                    disabled={isSystem}
                                    className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50 disabled:opacity-50"
                                >
                                    {CATEGORY_OPTIONS.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-foreground mb-1">Versão</label>
                                <input
                                    type="text"
                                    value={version}
                                    onChange={e => setVersion(e.target.value)}
                                    disabled={isSystem}
                                    placeholder="1.0"
                                    className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50 disabled:opacity-50"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-foreground mb-1">Tags (separadas por vírgula)</label>
                            <input
                                type="text"
                                value={tagsRaw}
                                onChange={e => setTagsRaw(e.target.value)}
                                placeholder="jurídico, contratos, lgpd"
                                className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-foreground mb-1">Instructions (markdown) *</label>
                            <textarea
                                value={instructions}
                                onChange={e => setInstructions(e.target.value)}
                                required
                                rows={12}
                                placeholder="## Sua skill&#10;Você é um especialista em..."
                                className="w-full bg-secondary border border-border rounded px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50 font-mono"
                            />
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 text-danger-fg text-xs bg-danger-bg border border-danger-border rounded px-3 py-2">
                                <AlertCircle className="w-4 h-4" />
                                {error}
                            </div>
                        )}
                    </div>

                    <div className="px-6 py-4 border-t border-border bg-secondary/10 flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground transition-colors"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={saving}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 transition-colors disabled:opacity-50"
                        >
                            <Save className="w-4 h-4" />
                            {saving ? 'Salvando...' : 'Salvar'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ── Skill detail drawer ────────────────────────────────────────────────────

function SkillDetail({ skill, onClose }: { skill: CatalogSkill; onClose: () => void }) {
    const categoryColor = CATEGORY_COLORS[skill.category || ''] || CATEGORY_COLORS.automation;
    return (
        <div className="fixed inset-0 z-40 flex items-center justify-end" onClick={onClose}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div
                className="relative w-full max-w-2xl h-full bg-card border-l border-border shadow-2xl overflow-hidden flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="px-6 py-4 border-b border-border flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <Sparkles className="w-4 h-4 text-violet-400 shrink-0" />
                            <h2 className="text-lg font-semibold text-foreground truncate">{skill.name}</h2>
                            {skill.is_system && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-warning-bg text-warning-fg border border-warning-border shrink-0">
                                    <Lock className="w-3 h-3" /> sistema
                                </span>
                            )}
                        </div>
                        {skill.description && (
                            <p className="text-sm text-muted-foreground">{skill.description}</p>
                        )}
                        <div className="flex items-center gap-2 mt-2 text-xs">
                            {skill.category && (
                                <span className={`px-2 py-0.5 rounded border ${categoryColor}`}>
                                    {skill.category}
                                </span>
                            )}
                            <span className="text-muted-foreground">v{skill.version}</span>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors ml-4">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    {skill.tags.length > 0 && (
                        <div>
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                                <Tag className="w-3 h-3" /> Tags
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {skill.tags.map(t => (
                                    <span key={t} className="px-2 py-0.5 text-[11px] rounded-md bg-secondary/40 text-foreground border border-border/40">
                                        {t}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    <div>
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                            <FileText className="w-3 h-3" /> Instructions
                        </div>
                        <pre className="whitespace-pre-wrap text-xs text-foreground bg-secondary/20 border border-border/40 rounded-md p-4 font-mono leading-relaxed">
                            {skill.instructions}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function SkillsPage() {
    const { role } = useAuth();
    const { toast: showToast } = useToast();
    const [skills, setSkills]   = useState<CatalogSkill[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<CatalogSkill | null | 'new'>(null);
    const [viewing, setViewing] = useState<CatalogSkill | null>(null);
    const [filter, setFilter]   = useState<string>('all');

    const isAdmin = role === 'admin';

    const loadSkills = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.CATALOG_SKILLS);
            setSkills(res.data || []);
        } catch {
            showToast('Erro ao carregar skills', 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { loadSkills(); }, [loadSkills]);

    const handleDelete = async (skill: CatalogSkill) => {
        if (skill.is_system) {
            showToast('Skills do sistema não podem ser deletadas', 'error');
            return;
        }
        if (!confirm(`Deletar a skill "${skill.name}"?`)) return;
        try {
            await api.delete(ENDPOINTS.CATALOG_SKILL(skill.id));
            showToast('Skill deletada', 'success');
            await loadSkills();
        } catch {
            showToast('Erro ao deletar skill', 'error');
        }
    };

    const filteredSkills = filter === 'all'
        ? skills
        : skills.filter(s => s.category === filter);

    const grouped = {
        system: filteredSkills.filter(s => s.is_system),
        custom: filteredSkills.filter(s => !s.is_system),
    };

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
                <PageHeader
                    title="Skills & Templates"
                    subtitle="Capabilities reutilizáveis para assistentes — inspirado em anthropics/skills"
                    icon={<Sparkles className="w-5 h-5" />}
                    actions={
                        isAdmin && (
                            <button
                                onClick={() => setEditing('new')}
                                className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                                Nova Skill
                            </button>
                        )
                    }
                />

                {/* Filter chips */}
                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        onClick={() => setFilter('all')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                            filter === 'all'
                                ? 'bg-violet-500/20 text-violet-300 border-violet-500/30'
                                : 'bg-secondary/20 text-muted-foreground border-border/40 hover:text-foreground'
                        }`}
                    >
                        Todas ({skills.length})
                    </button>
                    {CATEGORY_OPTIONS.map(cat => {
                        const count = skills.filter(s => s.category === cat).length;
                        if (count === 0) return null;
                        return (
                            <button
                                key={cat}
                                onClick={() => setFilter(cat)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                                    filter === cat
                                        ? CATEGORY_COLORS[cat]
                                        : 'bg-secondary/20 text-muted-foreground border-border/40 hover:text-foreground'
                                }`}
                            >
                                {cat} ({count})
                            </button>
                        );
                    })}
                </div>

                {loading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                    </div>
                ) : skills.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <Sparkles className="w-10 h-10 mx-auto mb-2 opacity-30" />
                        <p className="text-sm">Nenhuma skill catalogada ainda.</p>
                    </div>
                ) : (
                    <>
                        {grouped.system.length > 0 && (
                            <div>
                                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1">
                                    <Lock className="w-3 h-3" /> Skills do Sistema
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {grouped.system.map(skill => (
                                        <SkillCard
                                            key={skill.id}
                                            skill={skill}
                                            isAdmin={isAdmin}
                                            onView={() => setViewing(skill)}
                                            onEdit={() => setEditing(skill)}
                                            onDelete={() => handleDelete(skill)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {grouped.custom.length > 0 && (
                            <div>
                                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                                    Custom
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {grouped.custom.map(skill => (
                                        <SkillCard
                                            key={skill.id}
                                            skill={skill}
                                            isAdmin={isAdmin}
                                            onView={() => setViewing(skill)}
                                            onEdit={() => setEditing(skill)}
                                            onDelete={() => handleDelete(skill)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {editing !== null && (
                <SkillModal
                    skill={editing === 'new' ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={loadSkills}
                />
            )}
            {viewing && (
                <SkillDetail skill={viewing} onClose={() => setViewing(null)} />
            )}
        </div>
    );
}

// ── Skill Card ─────────────────────────────────────────────────────────────

function SkillCard({
    skill, isAdmin, onView, onEdit, onDelete,
}: {
    skill: CatalogSkill;
    isAdmin: boolean;
    onView: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const categoryColor = CATEGORY_COLORS[skill.category || ''] || CATEGORY_COLORS.automation;

    return (
        <div className="bg-card border border-border rounded-xl p-4 hover:border-violet-500/30 transition-colors flex flex-col">
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-foreground truncate">{skill.name}</div>
                    {skill.description && (
                        <div className="text-xs text-muted-foreground line-clamp-2 mt-1">{skill.description}</div>
                    )}
                </div>
                {skill.is_system && (
                    <Lock className="w-3 h-3 text-warning-fg shrink-0 mt-1" />
                )}
            </div>

            <div className="flex items-center gap-2 text-[10px] mb-3">
                {skill.category && (
                    <span className={`px-1.5 py-0.5 rounded border ${categoryColor}`}>
                        {skill.category}
                    </span>
                )}
                <span className="text-muted-foreground">v{skill.version}</span>
            </div>

            {skill.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                    {skill.tags.slice(0, 4).map(t => (
                        <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-secondary/40 text-muted-foreground border border-border/30">
                            {t}
                        </span>
                    ))}
                    {skill.tags.length > 4 && (
                        <span className="text-[10px] text-muted-foreground">+{skill.tags.length - 4}</span>
                    )}
                </div>
            )}

            <div className="flex items-center gap-2 mt-auto">
                <button
                    onClick={onView}
                    className="flex-1 px-2 py-1.5 text-xs rounded-md bg-secondary/30 text-foreground border border-border/40 hover:bg-secondary/50 transition-colors"
                >
                    Ver
                </button>
                {isAdmin && (
                    <>
                        <button
                            onClick={onEdit}
                            className="px-2 py-1.5 text-xs rounded-md bg-secondary/30 text-muted-foreground border border-border/40 hover:text-foreground transition-colors"
                            title="Editar"
                        >
                            <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        {!skill.is_system && (
                            <button
                                onClick={onDelete}
                                className="px-2 py-1.5 text-xs rounded-md bg-danger-bg text-danger-fg border border-danger-border hover:bg-danger-bg transition-colors"
                                title="Deletar"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
