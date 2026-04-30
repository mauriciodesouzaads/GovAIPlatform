import { Suspense } from 'react';
import { ExecucoesLayout } from '@/components/execucoes/execucoes-layout';
import { EvidenciasView } from '@/components/evidencias/evidencias-view';

/**
 * /evidencias — FASE 14.0/6c.B.2
 *
 * Substitui a antiga rota /execucoes (que continua acessível como
 * redirect para preservar links externos). 3 sub-abas filtram por
 * source: 'chat' (originado em /chat mode=code), 'admin' (via SDK
 * ou /execucoes/nova), 'test' (suítes de regressão).
 *
 * Layout reusado de ExecucoesLayout para preservar o sidebar
 * lateral de sessões CLI ativas — mesma estrutura visual, mesmo
 * componente, sem duplicação.
 */
export default function EvidenciasPage() {
    return (
        <ExecucoesLayout hideHeader>
            <Suspense fallback={<div className="text-sm text-text-500">Carregando…</div>}>
                <EvidenciasView />
            </Suspense>
        </ExecucoesLayout>
    );
}
