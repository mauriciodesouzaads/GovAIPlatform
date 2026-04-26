import { ExecucoesLayout } from '@/components/execucoes/execucoes-layout';
import { WorkItemList } from '@/components/execucoes/work-item-list';

export default function ExecucoesPage() {
    return (
        <ExecucoesLayout>
            <WorkItemList />
        </ExecucoesLayout>
    );
}
