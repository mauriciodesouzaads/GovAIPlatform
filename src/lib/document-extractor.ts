/**
 * Document text extractor — FASE 14.0/6a₁
 * ---------------------------------------------------------------------------
 * Reads a file from disk and returns its plain-text contents. Supports
 * the four MIME types whitelisted by RAG_SUPPORTED_MIMES:
 *
 *   - application/pdf
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document (DOCX)
 *   - text/plain
 *   - text/markdown
 *
 * pdf-parse handles digital PDFs cleanly. Scanned PDFs (image-only)
 * give back empty text — we surface that as an extraction error
 * upstream so the operator can re-upload after OCR. Mammoth handles
 * .docx; .doc (old binary format) is intentionally not supported in
 * 6a₁.
 */

import { promises as fs } from 'fs';

export const SUPPORTED_MIMES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
] as const;

export type SupportedMime = typeof SUPPORTED_MIMES[number];

export function isSupportedMime(mime: string): mime is SupportedMime {
    return (SUPPORTED_MIMES as readonly string[]).includes(mime);
}

export interface ExtractedContent {
    text: string;
    char_count: number;
    page_count?: number;
}

export async function extractContent(
    filePath: string,
    mimeType: string,
): Promise<ExtractedContent> {
    if (mimeType === 'application/pdf') {
        // pdf-parse is loaded lazily because its index file pulls in a
        // test fixture at module-load time, which crashes when the dist
        // dir is mounted read-only inside the api container.
        const pdfParse = (await import('pdf-parse')).default;
        const buffer = await fs.readFile(filePath);
        const result = await pdfParse(buffer);
        return {
            text: result.text || '',
            char_count: (result.text || '').length,
            page_count: result.numpages ?? undefined,
        };
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        const text = result.value || '';
        return { text, char_count: text.length };
    }
    if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
        const text = await fs.readFile(filePath, 'utf-8');
        return { text, char_count: text.length };
    }
    throw new Error(`Unsupported MIME type: ${mimeType}`);
}
