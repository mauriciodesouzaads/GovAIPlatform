/**
 * GovAI Platform — SMTP Mailer
 *
 * Wrapper nodemailer para notificações transacionais.
 * Responsável exclusivamente pelo envio de emails institucionais do sistema:
 *   - Notificação ao DPO quando consentimento LGPD é revogado
 *   - Confirmação ao DPO quando consentimento LGPD é concedido
 *
 * Configuração via env vars (todas opcionais — degradação graceful se ausentes):
 *   SMTP_HOST         Servidor SMTP (ex: smtp.mailgun.org)
 *   SMTP_PORT         Porta SMTP (padrão: 587 — STARTTLS)
 *   SMTP_SECURE       'true' para SSL direto (porta 465), 'false' para STARTTLS (padrão)
 *   SMTP_USER         Usuário SMTP
 *   SMTP_PASSWORD     Senha SMTP
 *   SMTP_FROM         Remetente (ex: "GovAI Platform <govai@company.com>")
 *   DPO_EMAIL         Email do DPO/responsável LGPD que recebe notificações
 */

import nodemailer, { Transporter, SentMessageInfo } from 'nodemailer';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConsentNoticePayload {
    orgId: string;
    orgName: string;
    consent: boolean;
    piiStrip: boolean;
    performedByEmail: string | null;
    performedAt: Date;
    auditLogId: string;
}

export type MailResult =
    | { sent: true; messageId: string }
    | { sent: false; skipped: true; reason: string }
    | { sent: false; error: string };

// ── Config validation ────────────────────────────────────────────────────────

interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
    dpoEmail: string;
}

function loadSmtpConfig(): SmtpConfig | null {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const password = process.env.SMTP_PASSWORD;
    const from = process.env.SMTP_FROM;
    const dpoEmail = process.env.DPO_EMAIL;

    if (!host || !user || !password || !from || !dpoEmail) {
        return null;
    }

    return {
        host,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user,
        password,
        from,
        dpoEmail,
    };
}

// ── Mailer class ──────────────────────────────────────────────────────────────

export class Mailer {
    private transporter: Transporter | null = null;
    private config: SmtpConfig | null = null;

    constructor() {
        this.config = loadSmtpConfig();
        if (this.config) {
            this.transporter = nodemailer.createTransport({
                host: this.config.host,
                port: this.config.port,
                secure: this.config.secure,
                auth: {
                    user: this.config.user,
                    pass: this.config.password,
                },
                // Pool de conexões para evitar re-handshake por email
                pool: true,
                maxConnections: 3,
                maxMessages: 100,
            });
        }
    }

    /**
     * Verifica se o mailer está configurado. Útil para health checks.
     */
    isConfigured(): boolean {
        return this.transporter !== null;
    }

    /**
     * Envia notificação ao DPO quando o consentimento de telemetria é alterado.
     * Conforme LGPD Art. 41 — encarregado (DPO) deve ser notificado de eventos
     * relevantes ao tratamento de dados pessoais.
     */
    async sendConsentChangeNotice(payload: ConsentNoticePayload): Promise<MailResult> {
        if (!this.transporter || !this.config) {
            const reason = 'SMTP não configurado (SMTP_HOST/SMTP_USER/SMTP_PASSWORD/SMTP_FROM/DPO_EMAIL ausentes)';
            return { sent: false, skipped: true, reason };
        }

        const actionLabel = payload.consent ? 'CONCEDIDO' : 'REVOGADO';
        const actionColor = payload.consent ? '#16a34a' : '#dc2626';
        const performedByLabel = payload.performedByEmail ?? 'sistema';
        const dateLabel = payload.performedAt.toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            dateStyle: 'short',
            timeStyle: 'medium',
        });

        const subject = `[GovAI] Consentimento LGPD ${actionLabel} — ${payload.orgName}`;

        const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1);">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:24px 32px;">
              <span style="color:#fff;font-size:18px;font-weight:700;">GovAI Platform</span>
              <span style="color:#94a3b8;font-size:13px;margin-left:12px;">Notificação LGPD</span>
            </td>
          </tr>
          <!-- Status badge -->
          <tr>
            <td style="padding:32px 32px 0;">
              <div style="display:inline-block;background:${actionColor}15;border:1px solid ${actionColor}40;border-radius:8px;padding:8px 16px;">
                <span style="color:${actionColor};font-weight:700;font-size:15px;">Consentimento de Telemetria: ${actionLabel}</span>
              </div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:24px 32px;">
              <p style="margin:0 0 16px;color:#374151;font-size:14px;line-height:1.6;">
                O consentimento de envio de telemetria ao Langfuse foi <strong>${actionLabel.toLowerCase()}</strong>
                para a organização abaixo. Esta notificação é enviada conforme
                <strong>LGPD Art. 41</strong> — obrigação do encarregado de dados (DPO).
              </p>
              <!-- Details table -->
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px;">
                <tr style="background:#f9fafb;">
                  <td style="padding:10px 16px;color:#6b7280;font-weight:600;width:40%;">Organização</td>
                  <td style="padding:10px 16px;color:#111827;font-weight:500;">${escapeHtml(payload.orgName)}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;color:#6b7280;font-weight:600;border-top:1px solid #f3f4f6;">ID da Organização</td>
                  <td style="padding:10px 16px;color:#374151;font-family:monospace;border-top:1px solid #f3f4f6;">${payload.orgId}</td>
                </tr>
                <tr style="background:#f9fafb;">
                  <td style="padding:10px 16px;color:#6b7280;font-weight:600;border-top:1px solid #f3f4f6;">PII Strip</td>
                  <td style="padding:10px 16px;color:#374151;border-top:1px solid #f3f4f6;">${payload.piiStrip ? 'Ativo (somente métricas)' : 'Inativo (prompts completos)'}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;color:#6b7280;font-weight:600;border-top:1px solid #f3f4f6;">Realizado por</td>
                  <td style="padding:10px 16px;color:#374151;border-top:1px solid #f3f4f6;">${escapeHtml(performedByLabel)}</td>
                </tr>
                <tr style="background:#f9fafb;">
                  <td style="padding:10px 16px;color:#6b7280;font-weight:600;border-top:1px solid #f3f4f6;">Data/hora (BRT)</td>
                  <td style="padding:10px 16px;color:#374151;border-top:1px solid #f3f4f6;">${dateLabel}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;color:#6b7280;font-weight:600;border-top:1px solid #f3f4f6;">Audit Log ID</td>
                  <td style="padding:10px 16px;color:#374151;font-family:monospace;font-size:11px;border-top:1px solid #f3f4f6;">${payload.auditLogId}</td>
                </tr>
              </table>
              ${!payload.consent ? `
              <div style="margin-top:20px;background:#fef3c7;border:1px solid #f59e0b40;border-radius:8px;padding:14px 16px;">
                <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5;">
                  <strong>⚠ Ação necessária:</strong> Com o consentimento revogado, o envio de telemetria ao Langfuse
                  foi suspenso imediatamente para esta organização. Verifique se há pendências no plano de tratamento de dados
                  conforme a política de privacidade vigente.
                </p>
              </div>` : ''}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#9ca3af;font-size:11px;line-height:1.5;">
                Esta é uma notificação automática do GovAI Platform. O evento está registrado
                em <code>audit_logs_partitioned</code> com assinatura HMAC-SHA256 imutável.<br>
                Não responda este email. Em caso de dúvidas, contate a equipe SRE.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

        const text = [
            `GovAI Platform — Notificação LGPD`,
            ``,
            `Consentimento de Telemetria: ${actionLabel}`,
            ``,
            `Organização   : ${payload.orgName} (${payload.orgId})`,
            `PII Strip     : ${payload.piiStrip ? 'Ativo' : 'Inativo'}`,
            `Realizado por : ${performedByLabel}`,
            `Data/hora     : ${dateLabel}`,
            `Audit Log ID  : ${payload.auditLogId}`,
            ``,
            `Esta notificação é enviada conforme LGPD Art. 41.`,
        ].join('\n');

        try {
            const info: SentMessageInfo = await this.transporter.sendMail({
                from: this.config.from,
                to: this.config.dpoEmail,
                subject,
                text,
                html,
            });
            return { sent: true, messageId: info.messageId };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { sent: false, error: message };
        }
    }

    /**
     * Fecha o pool de conexões SMTP (para graceful shutdown).
     */
    close(): void {
        this.transporter?.close();
    }
}

// ── Escape helper ─────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const mailer = new Mailer();
