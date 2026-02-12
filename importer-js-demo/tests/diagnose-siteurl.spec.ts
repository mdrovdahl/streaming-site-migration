import { test, expect } from '@playwright/test';

test('trace siteurl after import', async ({ page }) => {
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

    // 1. Check siteurl in raw SQLite (no WP loading)
    const r1 = await pg.run({
      code: `<?php
$pdo = new PDO('sqlite:${docroot}/wp-content/database/.ht.sqlite');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

echo "=== RAW SITEURL CHECK ===\\n";
$stmt = $pdo->query("SELECT option_id, option_name, typeof(option_value), length(option_value), hex(substr(option_value,1,40)) FROM wp_options WHERE option_name IN ('siteurl','home','blogname','blogdescription') ORDER BY option_name");
while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
  echo "id={$row[0]} name={$row[1]} type={$row[2]} len={$row[3]} hex={$row[4]}\\n";
}

// Check total options
echo "\\nTotal options: " . $pdo->query("SELECT COUNT(*) FROM wp_options")->fetchColumn() . "\\n";

// Check first 5 options to see data patterns
echo "\\nFirst 10 options (by ID):\\n";
$stmt = $pdo->query("SELECT option_id, option_name, typeof(option_value), length(option_value), substr(option_value,1,60) FROM wp_options ORDER BY option_id LIMIT 10");
while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
  echo "  id={$row[0]} name={$row[1]} type={$row[2]} len={$row[3]} val={$row[4]}\\n";
}
`,
    });

    // 2. Now try to boot WP with WP_INSTALLING and check wpdb state
    const r2 = await pg.run({
      code: `<?php
// Capture any wp_die calls
function my_custom_die_handler($msg, $title = '', $args = []) {
  echo "WP_DIE INTERCEPTED: " . (is_string($msg) ? substr(strip_tags($msg), 0, 200) : gettype($msg)) . "\\n";
  // DON'T exit - continue execution
}
function return_custom_die() { return 'my_custom_die_handler'; }

define('WP_INSTALLING', true);
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);

// Hook wp_die handler before loading WP
// Can't use add_filter before WP loads, but Playground has playground_add_filter
if (function_exists('playground_add_filter')) {
  playground_add_filter('wp_die_handler', 'return_custom_die');
}

ob_start();
require_once '${docroot}/wp-load.php';
$boot_output = ob_get_clean();

echo "Boot output length: " . strlen($boot_output) . "\\n";
if (strpos($boot_output, 'Error') !== false || strpos($boot_output, 'error') !== false) {
  echo "Boot output contains error: " . substr($boot_output, 0, 300) . "\\n";
}

global $wpdb;
echo "wpdb class: " . get_class($wpdb) . "\\n";
echo "wpdb prefix: " . $wpdb->prefix . "\\n";
echo "wpdb options: " . $wpdb->options . "\\n";

// Try reading siteurl via wpdb
$siteurl = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'siteurl'");
echo "siteurl via wpdb: " . var_export($siteurl, true) . "\\n";

$home = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'home'");
echo "home via wpdb: " . var_export($home, true) . "\\n";

$blogname = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'blogname'");
echo "blogname via wpdb: " . var_export($blogname, true) . "\\n";

echo "last_error: " . $wpdb->last_error . "\\n";
`,
    });

    return {
      r1: { exit: r1.exitCode, text: (r1.text ?? '').substring(0, 3000), err: (r1.errors ?? '').substring(0, 500) },
      r2: { exit: r2.exitCode, text: (r2.text ?? '').substring(0, 3000), err: (r2.errors ?? '').substring(0, 500) },
    };
  });

  console.log('=== R1: Raw SQLite ===');
  console.log(result.r1.text);
  if (result.r1.err) console.log('R1 errors:', result.r1.err);
  console.log('\n=== R2: Via wpdb ===');
  console.log(result.r2.text);
  if (result.r2.err) console.log('R2 errors:', result.r2.err);
});
