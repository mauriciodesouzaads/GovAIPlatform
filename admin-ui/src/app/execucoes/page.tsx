'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * /execucoes — FASE 14.0/6c.B.2 redirect para /evidencias.
 *
 * /execucoes foi consolidado em /evidencias com 3 sub-abas. Mantemos
 * o redirect (em vez de deletar) para preservar links externos antigos
 * (slack messages, docs internas, audit reports). O redirect é
 * client-side — Next.js dev server suportaria 308 server-side via
 * middleware, mas o ganho não justifica a configuração extra para v1.
 */
export default function ExecucoesRedirectPage() {
    return (
        <Suspense fallback={null}>
            <Redirect />
        </Suspense>
    );
}

function Redirect() {
    const router = useRouter();
    const sp = useSearchParams();
    useEffect(() => {
        const qs = sp.toString();
        router.replace(`/evidencias${qs ? `?${qs}` : ''}`);
    }, [router, sp]);
    return (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            Redirecionando para /evidencias…
        </div>
    );
}
