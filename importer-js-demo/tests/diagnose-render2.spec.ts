import { test, expect } from '@playwright/test';

test('diagnose WordPress error after import', async ({ page }) => {
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

    // 1. Check the actual wp_die error by capturing output
    const r1 = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

// Override wp_die to capture the error message instead of exiting
// We need to see what WordPress is complaining about
define('WP_INSTALLING', true);
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);

ob_start();
require_once '${docroot}/wp-load.php';
$output = ob_get_clean();

// If we get here, wp-load didn't die
echo "WP loaded OK\\n";
echo "Active theme: " . get_option('template') . "\\n";
echo "Stylesheet: " . get_option('stylesheet') . "\\n";
echo "siteurl: " . get_option('siteurl') . "\\n";
echo "home: " . get_option('home') . "\\n";
echo "upload_url_path: " . get_option('upload_url_path') . "\\n";

// Check theme exists on disk
$theme = wp_get_theme();
echo "Theme exists: " . ($theme->exists() ? 'yes' : 'no') . "\\n";
echo "Theme name: " . $theme->get('Name') . "\\n";

// List all themes
$themes = wp_get_themes();
echo "Available themes (" . count($themes) . "): " . implode(', ', array_keys($themes)) . "\\n";

// Check wp-content directory
echo "wp-content dir: " . WP_CONTENT_DIR . "\\n";
echo "theme root: " . get_theme_root() . "\\n";
$theme_root = get_theme_root();
if (is_dir($theme_root)) {
  $dirs = scandir($theme_root);
  echo "Themes on disk: " . implode(', ', array_diff($dirs, ['.', '..'])) . "\\n";
}
`,
    });

    // 2. Try loading WP WITHOUT WP_INSTALLING to see the error
    const r2 = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

ob_start();
require_once '${docroot}/wp-load.php';
$output = ob_get_clean();

echo "Output length: " . strlen($output) . "\\n";
echo "First 500 chars: " . substr($output, 0, 500) . "\\n";
`,
    });

    // 3. Check if db.php exists
    const r3 = await pg.run({
      code: `<?php
echo "db.php exists: " . (file_exists('${docroot}/wp-content/db.php') ? 'yes' : 'no') . "\\n";
echo "db.php size: " . (file_exists('${docroot}/wp-content/db.php') ? filesize('${docroot}/wp-content/db.php') : 'N/A') . "\\n";

// Check wp-config.php for DB settings
$config = file_get_contents('${docroot}/wp-config.php');
// Just show first few lines
$lines = explode("\\n", $config);
echo "wp-config.php first 30 lines:\\n";
for ($i = 0; $i < min(30, count($lines)); $i++) {
  echo $lines[$i] . "\\n";
}
`,
    });

    return {
      r1: { exit: r1.exitCode, text: (r1.text ?? '').substring(0, 3000), err: (r1.errors ?? '').substring(0, 1000) },
      r2: { exit: r2.exitCode, text: (r2.text ?? '').substring(0, 3000), err: (r2.errors ?? '').substring(0, 1000) },
      r3: { exit: r3.exitCode, text: (r3.text ?? '').substring(0, 3000), err: (r3.errors ?? '').substring(0, 500) },
    };
  });

  console.log('\n=== R1: WP_INSTALLING=true ===');
  console.log(`Exit: ${result.r1.exit}`);
  console.log(result.r1.text);
  if (result.r1.err) console.log(`Errors: ${result.r1.err}`);

  console.log('\n=== R2: Normal WP load ===');
  console.log(`Exit: ${result.r2.exit}`);
  console.log(result.r2.text);
  if (result.r2.err) console.log(`Errors: ${result.r2.err}`);

  console.log('\n=== R3: Config check ===');
  console.log(`Exit: ${result.r3.exit}`);
  console.log(result.r3.text);

  expect(result.r1.exit).toBe(0);
});
