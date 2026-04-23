/**
 * FASE 13.5a3 — runtime availability unit tests.
 *
 * Before this fix, `isRuntimeAvailable` returned `false` immediately
 * when the configured unix socket was missing, even if the TCP host
 * was configured. The adapter (`resolveRuntimeTarget`) already had a
 * clean TCP fallback, so the UI was stricter than usage. These tests
 * lock down the new behaviour: try socket first, fall back to TCP.
 *
 * See docs/ADR-023-runtime-availability-vs-target.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isRuntimeAvailable } from '../lib/runtime-profiles';

// `isRuntimeAvailable` uses `require('fs').accessSync(...)` internally.
// Rather than mocking the module (fragile with CJS require inside a
// TS module under vitest), we use real tmp paths: a file that exists
// for the positive case, and a deliberately non-existent path for the
// negative case. Simpler, more accurate, no module-loader trickery.

// Minimal RuntimeProfile-shaped fixture — we only touch `config` fields.
const profileWithSocket = {
    slug: 'test-runtime',
    display_name: 'Test',
    config: {
        socket_path_env: 'TEST_SOCKET_PATH',
        grpc_host_env: 'TEST_GRPC_HOST',
        container_service: 'test-runner',
        claim_level: 'open_governed',
        capabilities: [],
        approval: {},
    },
} as any;

describe('isRuntimeAvailable — socket fallback to TCP', () => {
    let origEnv: NodeJS.ProcessEnv;
    let tmpDir: string;
    let existingPath: string;
    const nonexistentPath = '/nonexistent/__govai_test__/never.sock';

    beforeEach(() => {
        origEnv = { ...process.env };
        tmpDir = mkdtempSync(join(tmpdir(), 'govai-runtime-test-'));
        existingPath = join(tmpDir, 'fake.sock');
        writeFileSync(existingPath, ''); // real file, accessSync succeeds
    });
    afterEach(() => {
        process.env = origEnv;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns true when socket exists', () => {
        process.env.TEST_SOCKET_PATH = existingPath;
        expect(isRuntimeAvailable(profileWithSocket)).toBe(true);
    });

    it('returns true when socket is missing but TCP host is set (fallback)', () => {
        process.env.TEST_SOCKET_PATH = nonexistentPath;
        process.env.TEST_GRPC_HOST = 'test-runner:50051';
        expect(isRuntimeAvailable(profileWithSocket)).toBe(true);
    });

    it('returns false when socket is missing AND no TCP host configured', () => {
        process.env.TEST_SOCKET_PATH = nonexistentPath;
        delete process.env.TEST_GRPC_HOST;
        expect(isRuntimeAvailable(profileWithSocket)).toBe(false);
    });

    it('returns true when no socket configured but TCP host is set', () => {
        delete process.env.TEST_SOCKET_PATH;
        process.env.TEST_GRPC_HOST = 'test-runner:50051';
        expect(isRuntimeAvailable(profileWithSocket)).toBe(true);
    });

    it('returns false when neither socket nor host configured', () => {
        delete process.env.TEST_SOCKET_PATH;
        delete process.env.TEST_GRPC_HOST;
        expect(isRuntimeAvailable(profileWithSocket)).toBe(false);
    });
});
