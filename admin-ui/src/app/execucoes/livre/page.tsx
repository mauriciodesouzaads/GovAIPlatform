'use client';

import { ExecucoesLayout } from '@/components/execucoes/execucoes-layout';
import { ModeTabs } from '@/components/execucoes/mode-tabs';
import { FreeformExecutionForm } from '@/components/execucoes/freeform-execution-form';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { useRunnersHealth } from '@/hooks/execucoes/use-runners-health';
import { useMcpServers } from '@/hooks/execucoes/use-mcp-servers';

/**
 * /execucoes/livre — Modo Livre landing page.
 *
 * Sits under the /execucoes layout and renders the freeform harness
 * picker. Engine availability comes from /runners/health (so the user
 * sees the same state as the header bar) and MCP servers come from
 * the registry.
 */
export default function NewExecucaoLivrePage() {
    const client = useRuntimeClient();
    const { runners } = useRunnersHealth(client);
    const { servers, loading: mcpLoading } = useMcpServers(client);

    return (
        <ExecucoesLayout>
            <ModeTabs />
            <FreeformExecutionForm
                client={client}
                runners={runners}
                mcpServers={servers}
                mcpLoading={mcpLoading}
            />
        </ExecucoesLayout>
    );
}
