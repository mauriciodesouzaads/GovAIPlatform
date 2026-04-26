'use client';

import { useParams } from 'next/navigation';
import { ExecucoesLayout } from '@/components/execucoes/execucoes-layout';
import { WorkItemDetail } from '@/components/execucoes/work-item-detail';

export default function WorkItemDetailPage() {
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
            <WorkItemDetail id={idStr} />
        </ExecucoesLayout>
    );
}
