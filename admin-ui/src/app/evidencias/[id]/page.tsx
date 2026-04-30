'use client';

import { useParams } from 'next/navigation';
import { ExecucoesLayout } from '@/components/execucoes/execucoes-layout';
import { WorkItemDetail } from '@/components/execucoes/work-item-detail';

/**
 * /evidencias/<id> — FASE 14.0/6c.B.2
 *
 * Reusa o WorkItemDetail criado em 6c.B (banner "Voltar à conversa"
 * já trata source='chat'). A diferença vs /execucoes/<id> é que essa
 * rota leva o usuário de volta a /evidencias (lista com tabs) ao
 * clicar "Lista" — comportamento esperado pelo basePath do card.
 */
export default function EvidenciaDetailPage() {
    const params = useParams();
    const id = params?.id;
    const idStr = Array.isArray(id) ? id[0] : id;

    if (!idStr) {
        return (
            <ExecucoesLayout>
                <div className="text-sm text-muted-foreground">ID inválido</div>
            </ExecucoesLayout>
        );
    }

    return (
        <ExecucoesLayout>
            <WorkItemDetail id={idStr} listHref="/evidencias" />
        </ExecucoesLayout>
    );
}
