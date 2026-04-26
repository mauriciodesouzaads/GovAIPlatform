'use client';

import { ExecucoesLayout } from '@/components/execucoes/execucoes-layout';
import { ModeTabs } from '@/components/execucoes/mode-tabs';
import { NewExecutionForm } from '@/components/execucoes/new-execution-form';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { useAssistants } from '@/hooks/execucoes/use-assistants';

/**
 * /execucoes/nova — Modo Agente landing page.
 *
 * Sits under the /execucoes layout (sessions sidebar + runners health
 * bar in the header) and renders the agent picker + briefing form.
 */
export default function NewExecucaoAgentePage() {
    const client = useRuntimeClient();
    const { assistants, loading, error } = useAssistants(client);

    return (
        <ExecucoesLayout>
            <ModeTabs />
            <NewExecutionForm
                client={client}
                assistants={assistants}
                loading={loading}
                error={error}
            />
        </ExecucoesLayout>
    );
}
