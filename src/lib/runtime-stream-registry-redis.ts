/**
 * Runtime Stream Registry — Redis Pub/Sub Layer (FASE 9)
 * (renamed from architect-stream-registry-redis in FASE 14.0/5b.2)
 * ---------------------------------------------------------------------------
 * Solves the multi-replica approval routing problem. See ADR-012 for context.
 *
 * Architecture:
 *   - Every API/worker process subscribes to `govai:runtime:control` at startup
 *   - When a worker picks up a cancel-run or resolve-approval job and the stream
 *     isn't found locally, it publishes a control message to the channel
 *   - All replicas receive the message; the one that owns the stream acts on it
 *
 * Why pub/sub (not list/stream): control messages are short-lived, idempotent,
 * and fan-out to all replicas is exactly what we want. Missing a message is OK
 * because the originating BullMQ job has its own retry — the system is eventually
 * consistent without pub/sub reliability guarantees.
 *
 * Feature flag: STREAM_REGISTRY_MODE
 *   - 'local' (default): no pub/sub, single-instance only, zero overhead
 *   - any other value ('distributed'): pub/sub enabled for multi-replica
 */

import IORedis from 'ioredis';
import { INSTANCE_ID, getStream, unregisterStream } from './runtime-stream-registry';

const CHANNEL = 'govai:runtime:control';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Separate connections for pub and sub — ioredis requires a dedicated
// connection for SUBSCRIBE mode (it blocks the connection for message
// delivery). Both connections use lazyConnect:false so they establish
// immediately on module load.
let pubClient: IORedis | null = null;
let subClient: IORedis | null = null;

function getPubClient(): IORedis {
    if (!pubClient) {
        pubClient = new IORedis(redisUrl, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: false,
            lazyConnect: false,
        });
        pubClient.on('error', (err) => console.error('[StreamRegistry Pub] Error:', err.message));
    }
    return pubClient;
}

function getSubClient(): IORedis {
    if (!subClient) {
        subClient = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: false,
        });
        subClient.on('error', (err) => console.error('[StreamRegistry Sub] Error:', err.message));
    }
    return subClient;
}

export interface ControlMessage {
    type: 'cancel' | 'respond';
    workItemId: string;
    originInstance: string;
    promptId?: string;
    reply?: string;
    timestamp: number;
}

/**
 * Publish a control message. All subscribed instances receive it;
 * only the one that owns the stream locally will act on it.
 */
export async function publishControl(
    msg: Omit<ControlMessage, 'originInstance' | 'timestamp'>
): Promise<void> {
    const fullMsg: ControlMessage = {
        ...msg,
        originInstance: INSTANCE_ID,
        timestamp: Date.now(),
    };
    try {
        await getPubClient().publish(CHANNEL, JSON.stringify(fullMsg));
    } catch (err) {
        console.error('[StreamRegistry] publishControl failed:', (err as Error).message);
        throw err;
    }
}

let subscribed = false;

/**
 * Subscribe to the control channel. Idempotent — safe to call multiple times.
 * Should be called once per process during startup (see server.ts).
 */
export async function subscribeToControl(): Promise<void> {
    if (subscribed) return;
    subscribed = true;

    const sub = getSubClient();
    await sub.subscribe(CHANNEL);

    sub.on('message', (channel: string, raw: string) => {
        if (channel !== CHANNEL) return;

        let msg: ControlMessage;
        try {
            msg = JSON.parse(raw) as ControlMessage;
        } catch {
            return;
        }

        // Check if this instance owns the stream
        const stream = getStream(msg.workItemId);
        if (!stream) return; // Another instance owns it (or stream already ended)

        try {
            if (msg.type === 'cancel') {
                stream.cancel();
                unregisterStream(msg.workItemId);
                console.log(`[StreamRegistry] Handled remote cancel for ${msg.workItemId} from ${msg.originInstance}`);
            } else if (msg.type === 'respond' && msg.promptId && typeof msg.reply === 'string') {
                stream.respond(msg.promptId, msg.reply);
                console.log(`[StreamRegistry] Handled remote respond for ${msg.workItemId} promptId=${msg.promptId} from ${msg.originInstance}`);
            }
        } catch (err) {
            console.warn(`[StreamRegistry] handler for ${msg.type} threw:`, (err as Error).message);
        }
    });

    console.log(`[StreamRegistry] Subscribed to ${CHANNEL} (instance=${INSTANCE_ID})`);
}

/**
 * Graceful shutdown. Called on SIGTERM to close Redis connections cleanly.
 */
export async function shutdownStreamRegistryRedis(): Promise<void> {
    if (subClient) {
        try { await subClient.unsubscribe(CHANNEL); } catch { /* ignore */ }
        try { await subClient.quit(); } catch { /* ignore */ }
        subClient = null;
    }
    if (pubClient) {
        try { await pubClient.quit(); } catch { /* ignore */ }
        pubClient = null;
    }
    subscribed = false;
}
