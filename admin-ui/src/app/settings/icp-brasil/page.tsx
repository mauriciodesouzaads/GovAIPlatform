'use client';

/**
 * ICP-Brasil certificates — FASE 13.2
 * ---------------------------------------------------------------------------
 * DPO / admin console for registering the org's ICP-Brasil certificate
 * (A1 file or A3 HSM) and exercising the signing pipeline end-to-end.
 */

import { useEffect, useState, useCallback } from 'react';
import { BadgeCheck, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Upload, X, Trash2 } from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

interface Certificate {
    id: string;
    subject_cn: string;
    subject_cnpj: string | null;
    issuer_cn: string;
    serial_number: string;
    valid_from: string;
    valid_until: string;
    cert_type: 'A1' | 'A3';
    pkcs11_module_path: string | null;
    pkcs11_slot_id: number | null;
    pkcs11_key_label: string | null;
    encrypted_key_path: string | null;
    is_active: boolean;
    created_at: string;
    deactivated_at: string | null;
    created_by_email?: string | null;
    is_expired: boolean;
    expires_in_30d: boolean;
}

function statusBadge(c: Certificate) {
    if (!c.is_active) {
        return <span className="text-xs px-2 py-0.5 rounded-full border border-gray-500/30 bg-gray-500/10 text-gray-400">Desativado</span>;
    }
    if (c.is_expired) {
        return <span className="text-xs px-2 py-0.5 rounded-full border border-danger-border bg-danger-bg text-danger-fg inline-flex items-center gap-1"><XCircle className="w-3 h-3" />Expirado</span>;
    }
    if (c.expires_in_30d) {
        return <span className="text-xs px-2 py-0.5 rounded-full border border-warning-border bg-warning-bg text-warning-fg inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Expira em ≤30d</span>;
    }
    return <span className="text-xs px-2 py-0.5 rounded-full border border-success-border bg-success-bg text-success-fg inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Ativo</span>;
}

export default function IcpBrasilPage() {
    const { toast } = useToast();
    const [certificates, setCertificates] = useState<Certificate[]>([]);
    const [loading, setLoading] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [verifying, setVerifying] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.ICP_CERTIFICATES);
            setCertificates(res.data?.certificates || []);
        } catch {
            toast('Falha ao listar certificados', 'error');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => { load(); }, [load]);

    const onVerify = async (id: string) => {
        setVerifying(id);
        try {
            const res = await api.post(ENDPOINTS.ICP_CERTIFICATE_VERIFY(id));
            const { mock_mode, signature_length } = res.data || {};
            toast(
                `Assinatura OK (${signature_length} bytes${mock_mode ? ' · modo mock' : ''})`,
                'success',
            );
        } catch (err: any) {
            const code = err?.response?.data?.code;
            const msg = err?.response?.data?.error || 'Falha ao verificar assinatura';
            toast(code ? `${msg} (${code})` : msg, 'error');
        } finally {
            setVerifying(null);
        }
    };

    const onDeactivate = async (id: string) => {
        if (!confirm('Desativar este certificado? A ação é reversível apenas reimportando.')) return;
        try {
            await api.delete(ENDPOINTS.ICP_CERTIFICATE_DELETE(id));
            toast('Certificado desativado', 'success');
            load();
        } catch {
            toast('Falha ao desativar', 'error');
        }
    };

    return (
        <div className="p-6 max-w-6xl mx-auto">
            <PageHeader
                title="Certificados ICP-Brasil"
                subtitle="Assinatura digital de evidências com validade jurídica — MP 2.200-2/2001"
                icon={<BadgeCheck className="w-5 h-5" />}
                actions={
                    <div className="flex gap-2">
                        <button
                            onClick={load}
                            className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-border bg-secondary/50 hover:bg-secondary"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Recarregar
                        </button>
                        <button
                            onClick={() => setModalOpen(true)}
                            className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90"
                        >
                            <Upload className="w-4 h-4" />
                            Novo Certificado
                        </button>
                    </div>
                }
            />

            <div className="border border-border rounded-xl overflow-hidden bg-card/40">
                <table className="w-full text-sm">
                    <thead className="bg-secondary/40 text-muted-foreground text-xs uppercase tracking-wider">
                        <tr>
                            <th className="text-left p-3 font-medium">Subject CN</th>
                            <th className="text-left p-3 font-medium">CNPJ</th>
                            <th className="text-left p-3 font-medium">Emissor</th>
                            <th className="text-left p-3 font-medium">Tipo</th>
                            <th className="text-left p-3 font-medium">Validade</th>
                            <th className="text-left p-3 font-medium">Status</th>
                            <th className="text-right p-3 font-medium">Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Carregando…</td></tr>
                        )}
                        {!loading && certificates.length === 0 && (
                            <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">
                                Nenhum certificado registrado. Clique em "Novo Certificado" para importar um.
                            </td></tr>
                        )}
                        {!loading && certificates.map((c) => (
                            <tr key={c.id} className="border-t border-border/50">
                                <td className="p-3">
                                    <div className="font-medium text-foreground">{c.subject_cn}</div>
                                    <div className="text-xs text-muted-foreground font-mono">{c.serial_number.substring(0, 16)}…</div>
                                </td>
                                <td className="p-3 font-mono text-xs">{c.subject_cnpj || '—'}</td>
                                <td className="p-3 text-xs">{c.issuer_cn}</td>
                                <td className="p-3">
                                    <span className={`text-xs px-2 py-0.5 rounded-md border ${c.cert_type === 'A3' ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-400' : 'border-info-border bg-info-bg text-info-fg'}`}>
                                        {c.cert_type}
                                    </span>
                                    {c.cert_type === 'A3' && (
                                        <div className="text-[10px] text-muted-foreground mt-1">slot {c.pkcs11_slot_id}</div>
                                    )}
                                </td>
                                <td className="p-3 text-xs">
                                    <div>{new Date(c.valid_from).toLocaleDateString('pt-BR')}</div>
                                    <div className="text-muted-foreground">→ {new Date(c.valid_until).toLocaleDateString('pt-BR')}</div>
                                </td>
                                <td className="p-3">{statusBadge(c)}</td>
                                <td className="p-3 text-right">
                                    {c.is_active && (
                                        <div className="inline-flex gap-2">
                                            <button
                                                onClick={() => onVerify(c.id)}
                                                disabled={verifying === c.id}
                                                className="text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary/50 disabled:opacity-40"
                                            >
                                                {verifying === c.id ? 'Verificando…' : 'Testar'}
                                            </button>
                                            <button
                                                onClick={() => onDeactivate(c.id)}
                                                className="text-xs px-2 py-1 rounded-md border border-danger-border bg-danger-bg text-danger-fg hover:bg-danger-bg inline-flex items-center gap-1"
                                            >
                                                <Trash2 className="w-3 h-3" />
                                                Desativar
                                            </button>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Regulatory note */}
            <div className="mt-5 text-xs text-muted-foreground border border-border/50 rounded-lg p-3 bg-secondary/20">
                <strong>Sobre ICP-Brasil:</strong> a Medida Provisória 2.200-2/2001 estabelece que
                assinaturas com certificados ICP-Brasil têm valor jurídico equivalente à assinatura
                manuscrita. CNJ e BACEN aceitam apenas este formato como prova formal em evidências.
                <span className="block mt-1">
                    <strong>A1</strong> = certificado em arquivo (PEM + passphrase via KMS);
                    <strong> A3</strong> = certificado em hardware (HSM via PKCS#11 — token USB, SmartCard ou HSM em rack).
                </span>
            </div>

            {modalOpen && (
                <UploadModal
                    onClose={() => setModalOpen(false)}
                    onSaved={() => { setModalOpen(false); load(); }}
                />
            )}
        </div>
    );
}

// ── Upload modal ──────────────────────────────────────────────────────────

function UploadModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
    const { toast } = useToast();
    const [certType, setCertType] = useState<'A1' | 'A3'>('A3');
    const [certPem, setCertPem] = useState('');
    const [pkcs11ModulePath, setPkcs11ModulePath] = useState('/usr/lib/softhsm/libsofthsm2.so');
    const [pkcs11SlotId, setPkcs11SlotId] = useState('0');
    const [pkcs11KeyLabel, setPkcs11KeyLabel] = useState('');
    const [encryptedKeyPath, setEncryptedKeyPath] = useState('');
    const [subjectCnpj, setSubjectCnpj] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (!certPem.trim()) return toast('Cole o PEM do certificado público', 'error');
        if (certType === 'A3' && (!pkcs11ModulePath.trim() || !pkcs11SlotId.trim())) {
            return toast('A3 exige módulo PKCS#11 + slot', 'error');
        }
        if (certType === 'A1' && !encryptedKeyPath.trim()) {
            return toast('A1 exige caminho da chave criptografada', 'error');
        }
        setBusy(true);
        try {
            await api.post(ENDPOINTS.ICP_CERTIFICATES, {
                cert_pem: certPem.trim(),
                cert_type: certType,
                pkcs11_module_path: certType === 'A3' ? pkcs11ModulePath.trim() : undefined,
                pkcs11_slot_id: certType === 'A3' ? parseInt(pkcs11SlotId) : undefined,
                pkcs11_key_label: certType === 'A3' ? (pkcs11KeyLabel.trim() || undefined) : undefined,
                encrypted_key_path: certType === 'A1' ? encryptedKeyPath.trim() : undefined,
                subject_cnpj: subjectCnpj.trim() || undefined,
            });
            toast('Certificado registrado', 'success');
            onSaved();
        } catch (err: any) {
            toast(err?.response?.data?.error || 'Falha ao registrar', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                <div className="flex items-center justify-between p-5 border-b border-border">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <BadgeCheck className="w-5 h-5" />
                        Novo Certificado ICP-Brasil
                    </h2>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-5 space-y-4">
                    <div>
                        <label className="text-xs text-muted-foreground block mb-1">Tipo</label>
                        <div className="inline-flex rounded-md border border-border overflow-hidden">
                            {(['A3', 'A1'] as const).map((t) => (
                                <button
                                    key={t}
                                    onClick={() => setCertType(t)}
                                    className={`px-3 py-1.5 text-sm ${certType === t ? 'bg-primary text-primary-foreground' : 'bg-secondary/30 text-foreground'}`}
                                >
                                    {t}{t === 'A3' ? ' — HSM' : ' — Arquivo'}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="text-xs text-muted-foreground block mb-1">
                            PEM do certificado público (----- BEGIN CERTIFICATE -----)
                        </label>
                        <textarea
                            value={certPem}
                            onChange={(e) => setCertPem(e.target.value)}
                            rows={8}
                            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                            className="w-full bg-secondary/40 border border-border rounded-md px-3 py-2 text-xs font-mono"
                        />
                    </div>

                    {certType === 'A3' && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            <label className="block md:col-span-2">
                                <span className="text-xs text-muted-foreground">Módulo PKCS#11</span>
                                <input
                                    value={pkcs11ModulePath}
                                    onChange={(e) => setPkcs11ModulePath(e.target.value)}
                                    className="mt-0.5 w-full bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                                />
                            </label>
                            <label className="block">
                                <span className="text-xs text-muted-foreground">Slot ID</span>
                                <input
                                    value={pkcs11SlotId}
                                    onChange={(e) => setPkcs11SlotId(e.target.value)}
                                    className="mt-0.5 w-full bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                                />
                            </label>
                            <label className="block md:col-span-3">
                                <span className="text-xs text-muted-foreground">Key label (opcional, default = subject CN)</span>
                                <input
                                    value={pkcs11KeyLabel}
                                    onChange={(e) => setPkcs11KeyLabel(e.target.value)}
                                    className="mt-0.5 w-full bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                                />
                            </label>
                        </div>
                    )}

                    {certType === 'A1' && (
                        <div>
                            <label className="block">
                                <span className="text-xs text-muted-foreground">Caminho da chave criptografada no host</span>
                                <input
                                    value={encryptedKeyPath}
                                    onChange={(e) => setEncryptedKeyPath(e.target.value)}
                                    placeholder="/var/lib/govai/icp/keys/orgA.p12.enc"
                                    className="mt-0.5 w-full bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                                />
                            </label>
                            <p className="text-[11px] text-muted-foreground mt-1">
                                Produção: a chave privada deve estar criptografada em disco e a passphrase vir do KMS
                                (AWS KMS, HashiCorp Vault, etc.) — deploy-time.
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="block">
                            <span className="text-xs text-muted-foreground">CNPJ (opcional — auto-extraído se OID 2.16.76.1.3.3 presente)</span>
                            <input
                                value={subjectCnpj}
                                onChange={(e) => setSubjectCnpj(e.target.value)}
                                placeholder="00.000.000/0001-00"
                                className="mt-0.5 w-full bg-secondary/40 border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                            />
                        </label>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
                    <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-border hover:bg-secondary/50">
                        Cancelar
                    </button>
                    <button
                        onClick={submit}
                        disabled={busy}
                        className="text-sm px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                    >
                        {busy ? 'Registrando…' : 'Registrar'}
                    </button>
                </div>
            </div>
        </div>
    );
}
