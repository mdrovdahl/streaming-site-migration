import { test, expect } from '@playwright/test';

test('full site import into Playground', async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);

  await page.goto('/');

  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });
  await expect(btnImport).toBeEnabled();

  await btnImport.click();

  const logEl = page.locator('#log');
  await expect(logEl).toBeVisible({ timeout: 10_000 });

  const phaseBadge = page.locator('#phase-badge');
  try {
    await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 25 * 60 * 1000 });
  } finally {
    const logText = await logEl.textContent().catch(() => '(could not read)');
    const badge = await phaseBadge.textContent().catch(() => '(unknown)');
    const status = await page.locator('#status-message').textContent().catch(() => '');
    console.log(`\n--- Phase: ${badge} | Status: ${status} ---`);
    console.log('--- Import log ---');
    console.log(logText);
  }

  await expect(phaseBadge).toHaveText('DONE');
  await expect(page.locator('#status-message')).toHaveText('Import complete!');

  // === DIAGNOSTICS ===

  // Full WP boot with wp_die intercept to see exact failure point
  const bootResult = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;
    const r = await pg.run({
      code: `<?php
// Override wp_die to capture the actual error
function my_die($msg, $title = '', $args = []) {
  echo "WP_DIE: " . (is_string($msg) ? substr(strip_tags($msg), 0, 200) : 'non-string') . "\\n";
  echo "title: $title\\n";
  // Show wpdb state at time of death
  global $wpdb;
  if (isset($wpdb) && is_object($wpdb)) {
    echo "wpdb class: " . get_class($wpdb) . "\\n";
    echo "wpdb ready: " . (property_exists($wpdb, 'ready') ? ($wpdb->ready ? 'Y' : 'N') : '?') . "\\n";
    echo "wpdb error: " . (property_exists($wpdb, 'error') ? var_export($wpdb->error, true) : '?') . "\\n";
    echo "wpdb last_error: " . (property_exists($wpdb, 'last_error') ? ($wpdb->last_error ?: '(none)') : '?') . "\\n";
  }
  $trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 15);
  foreach ($trace as $i => $frame) {
    $file = isset($frame['file']) ? $frame['file'] : '?';
    $line = isset($frame['line']) ? $frame['line'] : '?';
    $fn = isset($frame['function']) ? $frame['function'] : '?';
    echo "  #$i $file:$line $fn\\n";
  }
  exit(1);
}
if (function_exists('playground_add_filter')) {
  playground_add_filter('wp_die_handler', 'return_my_die');
}
function return_my_die() { return 'my_die'; }

ob_start();
require '${docroot}/wp-load.php';
$out = ob_get_clean();
echo "Boot OK! (output " . strlen($out) . " bytes)\\n";
global $wpdb;
echo "class: " . get_class($wpdb) . "\\n";
echo "ready: " . ($wpdb->ready ? 'YES' : 'NO') . "\\n";
echo "blogname: " . $wpdb->get_var("SELECT option_value FROM $wpdb->options WHERE option_name = 'blogname'") . "\\n";
`,
    });
    return { text: (r.text ?? '').substring(0, 3000), err: (r.errors ?? '').substring(0, 500) };
  });
  console.log('\n--- Full WP boot ---');
  console.log(bootResult.text);
  if (bootResult.err) console.log(`Errors: ${bootResult.err}`);

  // Check WordPress body in the iframe
  const iframe = page.frameLocator('#playground');
  const body = iframe.locator('body');
  await expect(body).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3000);

  const innerFrame = iframe.frameLocator('#wp');
  const innerBody = innerFrame.locator('body');
  await expect(innerBody).toBeVisible({ timeout: 15_000 });
  const innerText = await innerBody.textContent();
  console.log(`\n--- WordPress body (first 500 chars) ---`);
  console.log(innerText?.substring(0, 500));
  expect(innerText).not.toContain('Error establishing a database connection');
});
