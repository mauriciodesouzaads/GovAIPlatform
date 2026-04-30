'use client';

import { useRef, useState, useEffect, KeyboardEvent } from 'react';
import { Send, Paperclip, Loader2, X } from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { ModelSelector } from './ModelSelector';
import type { ChatClient } from '@/lib/chat-client';

/**
 * Input com:
 *   - textarea auto-resize (1 → 8 linhas max)
 *   - drag-and-drop de arquivos sobre toda a área
 *   - paste de imagens do clipboard
 *   - Enter envia, Shift+Enter quebra linha
 *   - botão "+" para anexar arquivos
 *   - ModelSelector inline (alterna LLM no meio da conversa)
 *   - botão enviar (seta verde)
 */
interface PendingAttachment {
    file: File;
    id?: string;
    uploading: boolean;
    error?: string;
}

export function ChatInput({
    client,
    convId,
    model,
    onModelChange,
    onSend,
    disabled = false,
}: {
    client: ChatClient | null;
    convId: string;
    model: string;
    onModelChange: (m: string) => void;
    onSend: (content: string, attachmentIds: string[]) => void;
    disabled?: boolean;
}) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [text, setText] = useState('');
    const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

    // Auto-resize textarea up to 8 lines.
    useEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.height = '0px';
        const max = 8 * 24; // ~24px line height
        ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    }, [text]);

    const uploadAll = async (files: File[]) => {
        if (!client) return;
        const initial: PendingAttachment[] = files.map(f => ({ file: f, uploading: true }));
        setAttachments(prev => [...prev, ...initial]);

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            try {
                const res = await client.uploadAttachment(convId, f);
                setAttachments(prev => prev.map(p =>
                    p.file === f ? { ...p, id: res.id, uploading: false } : p,
                ));
            } catch (err) {
                setAttachments(prev => prev.map(p =>
                    p.file === f ? { ...p, uploading: false, error: (err as Error).message } : p,
                ));
                toast.error(`Falha ao enviar ${f.name}`);
            }
        }
    };

    const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
        noClick: true,
        noKeyboard: true,
        onDrop: uploadAll,
    });

    // Paste images from clipboard.
    const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const items = Array.from(e.clipboardData.items);
        const files: File[] = [];
        for (const it of items) {
            if (it.kind === 'file') {
                const f = it.getAsFile();
                if (f) files.push(f);
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            uploadAll(files);
        }
    };

    function send() {
        const trimmed = text.trim();
        if (!trimmed || disabled) return;
        const ids = attachments.filter(a => a.id).map(a => a.id!);
        onSend(trimmed, ids);
        setText('');
        setAttachments([]);
    }

    function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
        }
    }

    const stillUploading = attachments.some(a => a.uploading);

    return (
        <div className="px-4 pb-4">
            <div
                {...getRootProps()}
                className={[
                    'rounded-2xl border bg-[#141820] transition-colors relative',
                    isDragActive
                        ? 'border-emerald-500/60 bg-emerald-500/5'
                        : 'border-border-200 focus-within:border-emerald-500/40',
                ].join(' ')}
            >
                <input {...getInputProps()} />

                {/* Attachments preview */}
                {attachments.length > 0 && (
                    <div className="px-3 pt-2 flex flex-wrap gap-2">
                        {attachments.map((a, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-bg-200 text-xs text-text-100"
                            >
                                {a.uploading && <Loader2 className="w-3 h-3 animate-spin" />}
                                <span className="truncate max-w-[160px]">{a.file.name}</span>
                                <button
                                    onClick={() =>
                                        setAttachments(prev => prev.filter((_, j) => j !== i))
                                    }
                                    className="text-text-500 hover:text-text-100"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <textarea
                    ref={taRef}
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={onKey}
                    onPaste={onPaste}
                    placeholder="Pergunte qualquer coisa…"
                    rows={1}
                    disabled={disabled}
                    className="w-full bg-transparent border-none focus:outline-none resize-none px-4 py-3 text-sm text-text-100 placeholder:text-text-500 leading-6 disabled:opacity-50"
                    style={{ minHeight: '24px' }}
                />

                <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={open}
                            disabled={disabled}
                            className="p-1.5 rounded-md text-text-500 hover:text-text-100 hover:bg-bg-200 transition-colors disabled:opacity-50"
                            title="Anexar arquivo"
                        >
                            <Paperclip className="w-4 h-4" />
                        </button>
                        <ModelSelector value={model} onChange={onModelChange} compact />
                    </div>
                    <button
                        onClick={send}
                        disabled={disabled || !text.trim() || stillUploading}
                        className="p-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-500/30 disabled:cursor-not-allowed text-white transition-colors"
                        title="Enviar (Enter)"
                    >
                        {disabled ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Send className="w-4 h-4" />
                        )}
                    </button>
                </div>

                {isDragActive && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-emerald-300 pointer-events-none">
                        Solte os arquivos aqui
                    </div>
                )}
            </div>
            <div className="text-[10px] text-text-500 text-center mt-2">
                As mensagens são auditadas e passam por DLP. CPF / CNPJ / cartão são bloqueados.
            </div>
        </div>
    );
}
