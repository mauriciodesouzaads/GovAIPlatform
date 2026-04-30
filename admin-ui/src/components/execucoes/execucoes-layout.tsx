'use client';

import { SessionsSidebar } from './sessions-sidebar';
import { RunnersHealthBar } from './runners-health-bar';

/**
 * Page-level layout for /execucoes/* routes. Mounts the sessions
 * sidebar on the left + a header with the runners health bar +
 * the main content slot.
 *
 * Sits inside the global LayoutWrapper, so the user sees:
 *
 *   [Global app sidebar] | [Sessions sidebar] | [Header + main]
 *
 * That nested-rail pattern matches Anthropic Claude Code Desktop
 * (April 2026 redesign): a primary nav at the edge, then a
 * subject-specific session list, then the focal content.
 */
export function ExecucoesLayout({
    children,
    // 6c.B.2 — quando /evidencias renderiza seu próprio título serif,
    // suprimimos o header desta layout p/ não criar dois h1s na página.
    // /execucoes/livre e /execucoes/nova continuam usando o header
    // padrão (default false).
    hideHeader = false,
}: {
    children: React.ReactNode;
    hideHeader?: boolean;
}) {
    return (
        <div className="flex h-full min-h-0">
            {/* Sessions rail */}
            <aside className="hidden md:flex w-72 flex-shrink-0 border-r border-border/40 bg-card/20 flex-col">
                <SessionsSidebar />
            </aside>

            {/* Right column: header + main */}
            <div className="flex-1 flex flex-col min-w-0">
                {!hideHeader && (
                    <header className="border-b border-border/40 bg-card/10 px-6 py-3 flex items-center justify-between gap-4 flex-shrink-0">
                        <div className="min-w-0">
                            <h1 className="text-lg font-semibold text-foreground/90">Evidências</h1>
                            <p className="text-[11px] text-muted-foreground">
                                Trilha de auditoria das interações governadas
                            </p>
                        </div>
                        <RunnersHealthBar />
                    </header>
                )}
                <main className="flex-1 overflow-y-auto p-6 min-w-0">{children}</main>
            </div>
        </div>
    );
}
