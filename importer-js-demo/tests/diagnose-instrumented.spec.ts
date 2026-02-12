import { test, expect } from '@playwright/test';

test('instrumented import', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);

  // Capture ALL console messages from the browser
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('sqlbatch') || text.includes('SQLSTATS') || text.includes('SQLERR') || text.includes('SQLCHECK')) {
      console.log(`[browser] ${text}`);
    }
  });

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });
  await btnImport.click();

  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 8 * 60 * 1000 });

  const badge = await phaseBadge.textContent();
  const status = await page.locator('#status-message').textContent();
  console.log(`Result: ${badge} | ${status}`);
});
