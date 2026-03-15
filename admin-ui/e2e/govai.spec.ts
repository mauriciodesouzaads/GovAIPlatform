import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:3001';
const API  = 'http://localhost:3000';

// Token compartilhado: 1 chamada de login por suite inteira.
// Evita atingir o rate limit de 10 req/15min do endpoint /v1/admin/login.
let sharedToken = '';

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${API}/v1/admin/login`, {
    data: { email: 'admin@orga.com', password: 'password' },
  });
  const body = await res.json() as { token?: string; error?: string };
  if (!body.token) throw new Error(`Login falhou: ${JSON.stringify(body)}`);
  sharedToken = body.token;
});

// Helper: injeta token via addInitScript (roda antes do React montar, sem chamar a API).
// Navega diretamente para a URL alvo — sem necessidade de passar por /login.
async function withAuth(page: Page, url: string): Promise<void> {
  await page.addInitScript((token) => {
    window.localStorage.setItem('govai_admin_token', token);
  }, sharedToken);
  await page.goto(url);
}

test.describe('GovAI Platform E2E', () => {
  test('T01 — Login form redireciona para dashboard', async ({ page }) => {
    // Mocka a resposta da API de login com o token já obtido no beforeAll.
    // Evita consumir rate limit adicional; testa o fluxo UI completo.
    await page.route(`${API}/v1/admin/login`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: sharedToken }),
      });
    });

    await page.goto(`${BASE}/login`);
    await page.fill('input[type="email"]', 'admin@orga.com');
    await page.fill('input[type="password"]', 'password');
    await page.click('button[type="submit"]:visible');
    await page.waitForURL(/localhost:3001\/?$/, { timeout: 15000 });
    await expect(page.locator('text=Security Command Center')).toBeVisible({ timeout: 10000 });
  });

  test('T02 — Dashboard mostra métricas reais', async ({ page }) => {
    await withAuth(page, `${BASE}/`);
    await expect(page.locator('text=Security Command Center')).toBeVisible({ timeout: 10000 });
    // Status da infra: OPERATIONAL quando db/redis conectados
    await expect(page.locator('text=OPERATIONAL').first()).toBeVisible({ timeout: 10000 });
  });

  test('T03 — Assistants lista assistentes publicados', async ({ page }) => {
    await withAuth(page, `${BASE}/assistants`);
    await expect(page.locator('text=AI Assistants')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=PUBLISHED').first()).toBeVisible({ timeout: 10000 });
  });

  test('T04 — Playground carrega com assistente no dropdown', async ({ page }) => {
    await withAuth(page, `${BASE}/playground`);
    await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible({ timeout: 10000 });
    const select = page.locator('select').first();
    await expect(select).toBeVisible({ timeout: 10000 });
    const options = await select.locator('option').count();
    expect(options).toBeGreaterThan(1);
  });

  test('T05 — Approvals mostra fila HITL', async ({ page }) => {
    await withAuth(page, `${BASE}/approvals`);
    await expect(page.getByRole('heading', { name: /Quarentena HITL/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Fila Pendente/i })).toBeVisible({ timeout: 10000 });
  });
});
