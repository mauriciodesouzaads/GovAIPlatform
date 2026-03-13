import { Pool } from 'pg';

/**
 * Singleton PG pool shared across server, execution service, and workers.
 * Creating multiple pools (one per module) wastes connections and
 * makes connection-count limits unpredictable in production.
 */
export const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pgPool.on('error', (err) => {
    console.error('[PG Pool] Idle client error:', err.message);
});
