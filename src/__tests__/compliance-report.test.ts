import { describe, it, expect } from 'vitest';
import { generateComplianceReport, ComplianceReportData } from '../lib/compliance-report';

describe('Compliance Report Generator', () => {

    it('should successfully build a PDF Buffer given valid report data', async () => {
        const dummyData: ComplianceReportData = {
            organization: { id: 'org-123', name: 'Tribunal Superior' },
            period: { start: '01/01/2026', end: '31/01/2026' },
            generatedAt: new Date().toISOString(),
            assistants: [
                { id: 'ast_123', name: 'Legal Assistant', status: 'active', created_at: new Date().toISOString() }
            ],
            apiKeys: [],
            summary: {
                totalExecutions: 1500,
                totalViolations: 12,
                totalErrors: 1,
                complianceRate: '99.2'
            },
            violationsByType: [
                { reason: 'PII_CPF_DETECTED', count: 10 },
                { reason: 'PROMPT_INJECTION', count: 2 }
            ],
            executions: [
                {
                    id: 'log-123',
                    action: 'EXECUTION_SUCCESS',
                    created_at: new Date().toISOString(),
                    signature: '1234567890abcdef1234567890abcdef',
                    signatureValid: true,
                    metadata: { tokens: 100 }
                }
            ]
        };

        const pdfBuffer = await generateComplianceReport(dummyData);

        // Assert the generated output is a valid Node Buffer containing PDF magic bytes
        expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
        expect(pdfBuffer.length).toBeGreaterThan(1000); // Standard minimal PDF size

        // Convert slice to string to verify PDF magic header
        const magicHeader = pdfBuffer.subarray(0, 5).toString('utf8');
        expect(magicHeader).toBe('%PDF-');
    });

    it('should generate a PDF even if the organization has 0 executions and 0 violations', async () => {
        const emptyData: ComplianceReportData = {
            organization: { id: 'org-456', name: 'Start-Up Inc' },
            period: { start: '01/01/2026', end: '31/01/2026' },
            generatedAt: new Date().toISOString(),
            assistants: [],
            apiKeys: [],
            summary: { totalExecutions: 0, totalViolations: 0, totalErrors: 0, complianceRate: '100.0' },
            violationsByType: [],
            executions: []
        };

        const pdfBuffer = await generateComplianceReport(emptyData);

        expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
        expect(pdfBuffer.length).toBeGreaterThan(1000);
    });

});
