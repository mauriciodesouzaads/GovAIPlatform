import PDFDocument from 'pdfkit';
import crypto from 'crypto';

/**
 * Compliance Report PDF Generator
 * 
 * Generates BCB 4.557 / LGPD compliant PDF reports containing:
 * 1. Organization header and report metadata
 * 2. Active AI Agent Inventory
 * 3. OPA Violation Summary (aggregated by type)
 * 4. Execution log with cryptographic signature verification
 */

export interface ComplianceReportData {
    organization: { id: string; name: string };
    period: { start: string; end: string };
    generatedAt: string;
    assistants: Array<{ id: string; name: string; status: string; created_at: string }>;
    apiKeys: Array<{ id: string; name: string; is_active: boolean; created_at: string }>;
    summary: {
        totalExecutions: number;
        totalViolations: number;
        totalErrors: number;
        complianceRate: string;
    };
    violationsByType: Array<{ reason: string; count: number }>;
    executions: Array<{
        id: string;
        action: string;
        created_at: string;
        signature: string;
        signatureValid: boolean;
        metadata: any;
    }>;
}

// ---------------------------------------------------------------------------
// PDF Helpers
// ---------------------------------------------------------------------------

const COLORS = {
    primary: '#0F172A',
    secondary: '#475569',
    accent: '#2563EB',
    success: '#16A34A',
    danger: '#DC2626',
    warning: '#D97706',
    lightBg: '#F8FAFC',
    border: '#E2E8F0',
    white: '#FFFFFF',
};

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, y: number): number {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(COLORS.primary).text(title, 50, y);
    doc.moveTo(50, y + 18).lineTo(545, y + 18).strokeColor(COLORS.accent).lineWidth(1.5).stroke();
    return y + 28;
}

function drawTableHeader(doc: PDFKit.PDFDocument, headers: string[], widths: number[], y: number): number {
    doc.rect(50, y, 495, 20).fill(COLORS.primary);
    let x = 55;
    headers.forEach((h, i) => {
        doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.white).text(h, x, y + 5, { width: widths[i] - 5 });
        x += widths[i];
    });
    return y + 20;
}

function drawTableRow(doc: PDFKit.PDFDocument, cells: string[], widths: number[], y: number, alt: boolean): number {
    if (alt) doc.rect(50, y, 495, 18).fill(COLORS.lightBg);
    let x = 55;
    cells.forEach((c, i) => {
        doc.fontSize(7.5).font('Helvetica').fillColor(COLORS.primary).text(c, x, y + 4, { width: widths[i] - 5 });
        x += widths[i];
    });
    return y + 18;
}

function checkPageBreak(doc: PDFKit.PDFDocument, y: number, needed: number = 60): number {
    if (y > 720 - needed) {
        doc.addPage();
        return 50;
    }
    return y;
}

// ---------------------------------------------------------------------------
// Generate Compliance Report PDF
// ---------------------------------------------------------------------------

export function generateComplianceReport(data: ComplianceReportData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ===== HEADER =====
        doc.rect(0, 0, 595, 100).fill(COLORS.primary);
        doc.fontSize(22).font('Helvetica-Bold').fillColor(COLORS.white).text('GovAI Platform', 50, 25);
        doc.fontSize(10).font('Helvetica').fillColor('#94A3B8').text('Relatório de Compliance — BCB 4.557 / LGPD', 50, 52);
        doc.fontSize(8).fillColor('#64748B')
            .text(`Organização: ${data.organization.name}`, 50, 72)
            .text(`Período: ${data.period.start} a ${data.period.end}`, 250, 72)
            .text(`Gerado em: ${data.generatedAt}`, 420, 72);

        // Compliance badge
        const rate = parseFloat(data.summary.complianceRate);
        const badgeColor = rate >= 95 ? COLORS.success : rate >= 80 ? COLORS.warning : COLORS.danger;
        doc.roundedRect(450, 20, 95, 40, 5).fill(badgeColor);
        doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.white).text(`${data.summary.complianceRate}%`, 460, 26, { width: 75, align: 'center' });
        doc.fontSize(7).text('COMPLIANCE', 460, 44, { width: 75, align: 'center' });

        let y = 120;

        // ===== SUMMARY CARDS =====
        const cards = [
            { label: 'Execuções', value: data.summary.totalExecutions.toString(), color: COLORS.accent },
            { label: 'Violações', value: data.summary.totalViolations.toString(), color: COLORS.danger },
            { label: 'Erros', value: data.summary.totalErrors.toString(), color: COLORS.warning },
            { label: 'Assistentes', value: data.assistants.length.toString(), color: COLORS.success },
        ];

        cards.forEach((card, i) => {
            const cx = 50 + i * 125;
            doc.roundedRect(cx, y, 115, 50, 4).fillAndStroke(COLORS.lightBg, COLORS.border);
            doc.fontSize(18).font('Helvetica-Bold').fillColor(card.color).text(card.value, cx + 10, y + 8, { width: 95 });
            doc.fontSize(8).font('Helvetica').fillColor(COLORS.secondary).text(card.label, cx + 10, y + 32, { width: 95 });
        });

        y += 70;

        // ===== LEGAL CONTEXT (STORYTELLING) =====
        y = drawSectionTitle(doc, 'Contextualização Fática e Base Legal', y);
        doc.fontSize(8.5).font('Helvetica').fillColor(COLORS.secondary).lineGap(2)
            .text('O presente documento consubstancia o Relatório Técnico de Conformidade (Audit Trail) da arquitetura de Inteligência Artificial da organização. Em estrito atendimento à Resolução BCB nº 4.557/17 (Gestão de Riscos) e à Lei Geral de Proteção de Dados (Lei nº 13.709/2018), este relatório garante a rastreabilidade, integridade e governança proativa sobre todos os fluxos de dados processados pelos agentes virtuais autônomos listados na seção subsequente.', 55, y, { width: 495, align: 'justify' });
        y += 50;

        // ===== SECTION 1: AGENT INVENTORY =====
        y = drawSectionTitle(doc, '1. Inventário de Agentes de IA Ativos', y);
        const agentHeaders = ['Nome', 'ID', 'Status', 'Criado em'];
        const agentWidths = [160, 170, 80, 85];
        y = drawTableHeader(doc, agentHeaders, agentWidths, y);

        data.assistants.forEach((a, i) => {
            y = checkPageBreak(doc, y);
            y = drawTableRow(doc, [
                a.name,
                a.id.substring(0, 20) + '...',
                a.status.toUpperCase(),
                new Date(a.created_at).toLocaleDateString('pt-BR'),
            ], agentWidths, y, i % 2 === 0);
        });

        if (data.assistants.length === 0) {
            doc.fontSize(9).font('Helvetica').fillColor(COLORS.secondary).text('Nenhum assistente cadastrado.', 55, y + 5);
            y += 25;
        }

        y += 15;
        y = checkPageBreak(doc, y, 80);

        // ===== SECTION 2: OPA VIOLATIONS SUMMARY =====
        y = drawSectionTitle(doc, '2. Análise Narrativa da Governança de Risco (Motor OPA)', y);

        doc.fontSize(8.5).font('Helvetica').fillColor(COLORS.secondary).lineGap(2)
            .text(`A plataforma operou sob o escrutínio contínuo do motor de políticas OPA (Open Policy Agent). Durante o período analisado, de um total de ${data.summary.totalExecutions} tentativas de execução, o sistema logrou êxito em interceptar e bloquear categoricamente ${data.summary.totalViolations} violações às diretrizes de segurança, privacidade ou compliance corporativo estatutário. A tabela infra sumariza a tipologia das ameaças mitigadas em tempo real pelas camadas de defesa.`, 55, y, { width: 495, align: 'justify' });
        y += 45;

        if (data.violationsByType.length > 0) {
            const vHeaders = ['Tipo de Violação', 'Ocorrências', '% do Total'];
            const vWidths = [300, 100, 95];
            y = drawTableHeader(doc, vHeaders, vWidths, y);

            data.violationsByType.forEach((v, i) => {
                y = checkPageBreak(doc, y);
                const pct = data.summary.totalViolations > 0
                    ? ((v.count / data.summary.totalViolations) * 100).toFixed(1) + '%'
                    : '0%';
                y = drawTableRow(doc, [v.reason, v.count.toString(), pct], vWidths, y, i % 2 === 0);
            });

            // Visual bar chart (text-based proportional bars)
            y += 10;
            y = checkPageBreak(doc, y, 40);
            doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.secondary).text('Distribuição Visual:', 55, y);
            y += 14;
            const maxCount = Math.max(...data.violationsByType.map(v => v.count), 1);
            data.violationsByType.forEach(v => {
                y = checkPageBreak(doc, y);
                const barWidth = Math.max((v.count / maxCount) * 300, 5);
                doc.fontSize(7).font('Helvetica').fillColor(COLORS.primary).text(v.reason.substring(0, 40), 55, y + 2, { width: 150 });
                doc.rect(210, y, barWidth, 12).fill(COLORS.danger);
                doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.white).text(v.count.toString(), 215, y + 2);
                y += 16;
            });
        } else {
            doc.fontSize(9).font('Helvetica').fillColor(COLORS.success).text('✓ Nenhuma violação registrada no período.', 55, y + 5);
            y += 25;
        }

        y += 15;
        y = checkPageBreak(doc, y, 80);

        // ===== SECTION 3: EXECUTION LOG WITH SIGNATURE VERIFICATION =====
        y = drawSectionTitle(doc, '3. Log de Execuções com Verificação Criptográfica', y);

        doc.fontSize(7.5).font('Helvetica').fillColor(COLORS.secondary)
            .text('Cada registro de auditoria contém uma assinatura HMAC-SHA256. O status "VÁLIDA" confirma que o registro não foi adulterado após sua criação.', 55, y, { width: 480 });
        y += 22;

        const logHeaders = ['Data/Hora', 'Ação', 'Assinatura (16 chars)', 'Verificação'];
        const logWidths = [100, 140, 145, 110];
        y = drawTableHeader(doc, logHeaders, logWidths, y);

        data.executions.forEach((log, i) => {
            y = checkPageBreak(doc, y);
            const sigStatus = log.signatureValid ? '✓ VÁLIDA' : '✗ INVÁLIDA';
            y = drawTableRow(doc, [
                new Date(log.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }),
                log.action.replace('_', ' '),
                log.signature.substring(0, 16) + '...',
                sigStatus,
            ], logWidths, y, i % 2 === 0);
        });

        // ===== SECTION 4: PARECER CONCLUSIVO =====
        y += 15;
        y = checkPageBreak(doc, y, 120);
        y = drawSectionTitle(doc, 'Parecer Conclusivo e Certificado de Conformidade', y);

        const isCompliant = rate >= 90;
        const conclusaoText = isCompliant
            ? `PARECER FAVORÁVEL: Atestamos para os devidos fins que a referida organização apresentou um Índice de Compliance de ${data.summary.complianceRate}% no período supracitado. Os mecanismos de defesa em profundidade operaram com eficácia comprovada, mitigando riscos de exposição de dados PII/PHI e garantindo a resiliência arquitetural exigida pelo arcabouço regulatório vigente.`
            : `PARECER COM RESSALVAS: Atestamos que a organização apresentou um Índice de Compliance de ${data.summary.complianceRate}% no período. A quantidade expressiva de anomalias/violações bloqueadas indica um elevado risco sistêmico na entrada de dados. Recomenda-se a revisão imediata do treinamento dos usuários ou o refinamento das heurísticas de DLP aplicadas aos agentes.`;

        doc.fontSize(9).font('Helvetica-Bold').fillColor(isCompliant ? COLORS.success : COLORS.warning)
            .text(isCompliant ? 'CERTIFICADO: CONFORME' : 'CERTIFICADO: ATENÇÃO REQUERIDA', 55, y);
        y += 15;

        doc.fontSize(8.5).font('Helvetica').fillColor(COLORS.secondary).lineGap(2)
            .text(conclusaoText, 55, y, { width: 495, align: 'justify' });
        y += 35;

        // ===== FOOTER (all pages) =====
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
            doc.switchToPage(i);
            doc.fontSize(7).font('Helvetica').fillColor(COLORS.secondary);
            doc.text(
                `GovAI Platform — Relatório de Compliance BCB 4.557 / LGPD  |  Página ${i + 1} de ${pages.count}`,
                50, 780, { width: 495, align: 'center' }
            );
        }

        doc.end();
    }); // end Promise
}
