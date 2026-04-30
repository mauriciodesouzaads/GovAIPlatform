'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * /execucoes/<id> — FASE 14.0/6c.B.2 redirect para /evidencias/<id>.
 *
 * Preserva deep-links de audit reports / slack threads que apontam
 * para o caminho antigo.
 */
export default function ExecucaoDetailRedirectPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id;
    const idStr = Array.isArray(id) ? id[0] : id;
    useEffect(() => {
        if (idStr) {
            router.replace(`/evidencias/${idStr}`);
        } else {
            router.replace('/evidencias');
        }
    }, [router, idStr]);
    return (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            Redirecionando para /evidencias/{idStr}…
        </div>
    );
}
