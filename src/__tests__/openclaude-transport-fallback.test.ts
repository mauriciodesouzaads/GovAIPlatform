/**
 * FASE 13.5b/0 — unit tests for the transport-selection helper.
 *
 * `pickTransportTarget` is the runtime-side counterpart of
 * `isRuntimeAvailable` (13.5a3): when a unix socket path is configured
 * but the file is missing / EACCES / otherwise unreachable, the adapter
 * now transparently falls back to the TCP host configured in the same
 * target — instead of crashing the gRPC dial with
 * `14 UNAVAILABLE: No connection established`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pickTransportTarget } from '../lib/openclaude-client';

describe('pickTransportTarget', () => {
    let tmpDir: string;
    let existingPath: string;
    const nonexistentPath = '/nonexistent/__govai_test__/never.sock';

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'govai-transport-'));
        existingPath = join(tmpDir, 'fake.sock');
        writeFileSync(existingPath, '');
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    const baseConfig = {
        host: 'openclaude-runner:50051',
        message: 'hi',
        workingDirectory: '/tmp/x',
        sessionId: 'session-1',
    };

    it('picks unix when socket exists and is accessible', () => {
        const r = pickTransportTarget({ ...baseConfig, socketPath: existingPath });
        expect(r.transport).toBe('unix');
        expect(r.fallback).toBe(false);
        expect(r.target).toBe(`unix:${existingPath}`);
    });

    it('falls back to TCP when socket file is missing', () => {
        const r = pickTransportTarget({ ...baseConfig, socketPath: nonexistentPath });
        expect(r.transport).toBe('tcp');
        expect(r.fallback).toBe(true);
        expect(r.target).toBe(baseConfig.host);
    });

    it('picks TCP directly when no socketPath is configured', () => {
        const r = pickTransportTarget({ ...baseConfig });
        expect(r.transport).toBe('tcp');
        expect(r.fallback).toBe(false);
        expect(r.target).toBe(baseConfig.host);
    });

    it('produces a valid gRPC unix:// target shape', () => {
        const r = pickTransportTarget({ ...baseConfig, socketPath: existingPath });
        expect(r.target.startsWith('unix:/')).toBe(true);
        // `unix:/abs/path` is the single-slash form accepted by @grpc/grpc-js
        expect(r.target).toMatch(/^unix:\/[^/]/);
    });
});
