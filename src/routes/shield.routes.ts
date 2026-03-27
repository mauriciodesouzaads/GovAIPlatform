/**
 * Shield Routes — Thin Orchestrator
 *
 * Registra as rotas do domínio Shield compostas de dois módulos:
 *   - shieldAdminRoutes      → /v1/admin/shield/*
 *   - shieldConsultantRoutes → /v1/consultant/tenants/:tenantOrgId/shield/*
 *
 * server.ts continua registrando apenas este arquivo via:
 *   fastify.register(shieldRoutes, { pgPool, requireRole })
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { shieldAdminRoutes } from './shield-admin.routes';
import { shieldConsultantRoutes } from './shield-consultant.routes';

export async function shieldRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    await shieldAdminRoutes(fastify, opts);
    await shieldConsultantRoutes(fastify, opts);
}
