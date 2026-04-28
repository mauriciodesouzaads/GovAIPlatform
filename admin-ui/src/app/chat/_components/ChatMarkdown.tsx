'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import 'highlight.js/styles/atom-one-dark.css';

/**
 * Markdown renderer for assistant messages.
 *
 * Highlight.js + atom-one-dark theme = good default for the dark
 * palette without paying the Shiki bundle cost (Shiki ships ~3MB
 * of JSON tokenizers; rehype-highlight uses highlight.js which is
 * already <100KB and covers the same languages we care about for
 * a chat product).
 *
 * Custom code-block renderer adds a "copy" button + language label
 * matching the [Claude.ai](http://Claude.ai) pattern.
 */
export function ChatMarkdown({ content }: { content: string }) {
    return (
        <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-0 prose-code:before:hidden prose-code:after:hidden prose-headings:text-zinc-100 prose-strong:text-zinc-100 prose-a:text-emerald-400 prose-li:my-0">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    pre: ({ children, ...props }) => {
                        // The <code> child carries the language class.
                        const childArr = Array.isArray(children) ? children : [children];
                        const codeChild = childArr.find(
                            c => typeof c === 'object' && c !== null && (c as any).type === 'code',
                        ) as any;
                        const lang = codeChild?.props?.className?.match(/language-(\w+)/)?.[1] ?? '';
                        const text = extractText(codeChild);
                        return <CodeBlock language={lang} raw={text}>{children}</CodeBlock>;
                    },
                    a: ({ children, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer">
                            {children}
                        </a>
                    ),
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}

function CodeBlock({
    children,
    language,
    raw,
}: {
    children: React.ReactNode;
    language: string;
    raw: string;
}) {
    const [copied, setCopied] = useState(false);
    async function copy() {
        try {
            await navigator.clipboard.writeText(raw);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
    }
    return (
        <div className="my-3 rounded-lg overflow-hidden border border-white/10 bg-[#0d1117]">
            <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/5">
                <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
                    {language || 'code'}
                </span>
                <button
                    onClick={copy}
                    className="text-[11px] text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1 transition-colors"
                >
                    {copied ? (
                        <>
                            <Check className="w-3 h-3" />
                            Copiado
                        </>
                    ) : (
                        <>
                            <Copy className="w-3 h-3" />
                            Copiar
                        </>
                    )}
                </button>
            </div>
            <pre className="p-3 overflow-x-auto text-[13px] leading-relaxed">
                {children}
            </pre>
        </div>
    );
}

function extractText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (typeof node === 'object' && node.props?.children) {
        return extractText(node.props.children);
    }
    return '';
}
