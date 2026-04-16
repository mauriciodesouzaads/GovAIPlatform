import { describe, it, expect } from 'vitest';

describe('Alerting worker (smoke)', () => {
    it('module imports cleanly without side-effects', async () => {
        const mod = await import('../workers/alerting.worker');
        expect(mod.alertingQueue).toBeDefined();
        expect(typeof mod.initAlertingWorker).toBe('function');
    });
});
