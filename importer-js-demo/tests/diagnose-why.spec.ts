import { test, expect } from '@playwright/test';

test('diagnose is_blog_installed failure', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });
  await btnImport.click();

  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });

  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    // Run diagnostics WITH WP_INSTALLING so we can query safely
    const r = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('WP_INSTALLING', true);
ob_start();
require_once '${docroot}/wp-load.php';
ob_end_clean();

global $wpdb;

echo "=== BASIC INFO ===\\n";
echo "wpdb class: " . get_class($wpdb) . "\\n";
echo "table_prefix: " . $wpdb->prefix . "\\n";
echo "wpdb->options: " . $wpdb->options . "\\n";

echo "\\n=== AUTOLOAD VALUES ===\\n";
$rows = $wpdb->get_results("SELECT autoload, COUNT(*) as cnt FROM {$wpdb->options} GROUP BY autoload");
foreach ($rows as $row) {
  echo "  autoload='" . $row->autoload . "': " . $row->cnt . " rows\\n";
}

echo "\\n=== SITEURL CHECK ===\\n";
$siteurl = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'siteurl'");
echo "siteurl: " . ($siteurl ?: '(null)') . "\\n";

echo "\\n=== WP_LOAD_ALLOPTIONS ===\\n";
$alloptions = wp_load_alloptions();
echo "alloptions count: " . (is_array($alloptions) ? count($alloptions) : gettype($alloptions)) . "\\n";
echo "siteurl in alloptions: " . (isset($alloptions['siteurl']) ? $alloptions['siteurl'] : '(not set)') . "\\n";
echo "blogname in alloptions: " . (isset($alloptions['blogname']) ? $alloptions['blogname'] : '(not set)') . "\\n";

echo "\\n=== DESCRIBE TABLES ===\\n";
$wp_tables = $wpdb->tables();
foreach ($wp_tables as $name => $table) {
  $describe = $wpdb->get_results("DESCRIBE $table");
  $err = $wpdb->last_error;
  if ($err) {
    echo "  DESCRIBE $table: ERROR - $err\\n";
  } else {
    echo "  DESCRIBE $table: " . count($describe) . " columns\\n";
  }
}

echo "\\n=== SQLITE TABLES (raw) ===\\n";
$tables = $wpdb->get_results("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", ARRAY_N);
if ($tables) {
  foreach ($tables as $row) {
    echo "  " . $row[0] . "\\n";
  }
} else {
  echo "  (no tables or sqlite_master query failed)\\n";
  echo "  last_error: " . $wpdb->last_error . "\\n";
}

echo "\\n=== OPTIONS SAMPLE ===\\n";
$opts = $wpdb->get_results("SELECT option_name, autoload, LEFT(option_value, 60) as val FROM {$wpdb->options} LIMIT 15");
foreach ($opts as $o) {
  echo "  {$o->option_name} [autoload={$o->autoload}]: {$o->val}\\n";
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 5000), err: (r.errors ?? '').substring(0, 1000) };
  });

  console.log(result.text);
  if (result.err) console.log(`ERRORS: ${result.err}`);
});
