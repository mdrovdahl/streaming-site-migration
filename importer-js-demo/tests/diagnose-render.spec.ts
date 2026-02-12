import { test, expect } from '@playwright/test';

/**
 * Diagnose why the imported site renders blank after import.
 * Runs import, then checks WordPress's response directly.
 */
test('diagnose post-import rendering', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });
  await btnImport.click();

  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });

  // Import done. Now run PHP diagnostics inside Playground.
  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;

    // 1. Check active theme
    const themeCheck = await pg.run({
      code: `<?php
define('WP_INSTALLING', true);
ob_start();
require_once '${await pg.documentRoot}/wp-load.php';
ob_end_clean();

echo "Active theme: " . get_option('template') . "\\n";
echo "Stylesheet: " . get_option('stylesheet') . "\\n";
echo "Theme root: " . get_theme_root() . "\\n";

$theme = wp_get_theme();
echo "Theme exists: " . ($theme->exists() ? 'yes' : 'no') . "\\n";
echo "Theme name: " . $theme->get('Name') . "\\n";
echo "Theme errors: " . json_encode($theme->errors()) . "\\n";

// Check if theme directory exists
$theme_dir = get_theme_root() . '/' . get_option('stylesheet');
echo "Theme dir exists: " . (is_dir($theme_dir) ? 'yes' : 'no') . "\\n";

// List available themes
$themes = wp_get_themes();
echo "Available themes: " . implode(', ', array_keys($themes)) . "\\n";

// Check siteurl and home
echo "siteurl: " . get_option('siteurl') . "\\n";
echo "home: " . get_option('home') . "\\n";
echo "upload_url_path: " . get_option('upload_url_path') . "\\n";

// Check db.php exists
echo "db.php exists: " . (file_exists(WP_CONTENT_DIR . '/db.php') ? 'yes' : 'no') . "\\n";
`,
    });

    // 2. Try rendering the homepage
    const renderCheck = await pg.run({
      code: `<?php
define('WP_INSTALLING', true);
ob_start();
require_once '${await pg.documentRoot}/wp-load.php';
$output = ob_get_clean();

// Now try to get the homepage
ob_start();
try {
  // Simulate a request to /
  $_SERVER['REQUEST_URI'] = '/';
  $_SERVER['REQUEST_METHOD'] = 'GET';
  $_SERVER['HTTP_HOST'] = 'localhost';

  // Load template
  $template = get_option('template');
  $stylesheet = get_option('stylesheet');

  echo "Template: $template\\n";
  echo "Stylesheet: $stylesheet\\n";

  $theme_root = get_theme_root();
  echo "Theme root: $theme_root\\n";
  echo "Template dir: $theme_root/$template\\n";
  echo "Template dir exists: " . (is_dir("$theme_root/$template") ? 'yes' : 'no') . "\\n";

  // Check if index.php exists in theme
  $index = "$theme_root/$template/index.php";
  echo "index.php exists: " . (file_exists($index) ? 'yes' : 'no') . "\\n";

  // Check if style.css exists
  $style = "$theme_root/$stylesheet/style.css";
  echo "style.css exists: " . (file_exists($style) ? 'yes' : 'no') . "\\n";

} catch (Throwable $e) {
  echo "Error: " . $e->getMessage() . "\\n";
}
$renderOutput = ob_get_clean();
echo $renderOutput;
`,
    });

    return {
      theme: { exit: themeCheck.exitCode, text: (themeCheck.text ?? '').substring(0, 2000), err: (themeCheck.errors ?? '').substring(0, 500) },
      render: { exit: renderCheck.exitCode, text: (renderCheck.text ?? '').substring(0, 2000), err: (renderCheck.errors ?? '').substring(0, 500) },
    };
  });

  console.log('\n=== Theme Check ===');
  console.log(`Exit: ${result.theme.exit}`);
  console.log(result.theme.text);
  if (result.theme.err) console.log(`Errors: ${result.theme.err}`);

  console.log('\n=== Render Check ===');
  console.log(`Exit: ${result.render.exit}`);
  console.log(result.render.text);
  if (result.render.err) console.log(`Errors: ${result.render.err}`);

  expect(result.theme.exit).toBe(0);
});
