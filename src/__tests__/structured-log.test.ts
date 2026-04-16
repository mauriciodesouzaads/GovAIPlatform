import { describe, it, expect, vi } from 'vitest';
import { enrichLog, logEvent } from '../lib/structured-log';

describe('Structured logging', () => {
    it('enrichLog preserves canonical fields', () => {
        const result = enrichLog({
            component: 'gateway',
            outcome: 'blocked',
            org_id: 'org-1',
        });
        expect(result.component).toBe('gateway');
        expect(result.outcome).toBe('blocked');
        expect(result.org_id).toBe('org-1');
    });

    it('logEvent writes JSON in production mode', () => {
        const orig = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        logEvent({ component: 'test', outcome: 'success' }, 'test message');

        expect(writeSpy).toHaveBeenCalled();
        const call = writeSpy.mock.calls[0]![0] as string;
        const parsed = JSON.parse(call.trim());
        expect(parsed.component).toBe('test');
        expect(parsed.msg).toBe('test message');
        expect(parsed.time).toBeDefined();

        writeSpy.mockRestore();
        process.env.NODE_ENV = orig;
    });
});
