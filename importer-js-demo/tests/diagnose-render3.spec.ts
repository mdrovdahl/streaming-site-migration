import { test, expect } from '@playwright/test';

test('diagnose WP rendering after import', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });
  await btnImport.click();

  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });

  // Diagnose: theme, plugins, and page rendering
  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    const r = await pg.run({
      code: `<?php
function _import_noop_die($msg = '', $title = '', $args = []) {
  echo "WP_DIE called: " . (is_string($msg) ? substr(strip_tags($msg), 0, 300) : gettype($msg)) . "\\n";
}
function _import_return_noop_die() { return '_import_noop_die'; }
if (function_exists('playground_add_filter')) {
  playground_add_filter('wp_die_handler', '_import_return_noop_die');
}

define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');

ob_start();
require_once '${docroot}/wp-load.php';
$boot_output = ob_get_clean();
if (strlen($boot_output) > 0) {
  echo "Boot output (" . strlen($boot_output) . " bytes): " . substr($boot_output, 0, 500) . "\\n\\n";
}

global $wpdb;

// 1. Theme info
echo "=== THEME STATE ===\\n";
$template = get_option('template');
$stylesheet = get_option('stylesheet');
echo "template option: $template\\n";
echo "stylesheet option: $stylesheet\\n";
echo "template dir: " . get_template_directory() . "\\n";
echo "template dir exists: " . (is_dir(get_template_directory()) ? 'YES' : 'NO') . "\\n";
echo "stylesheet dir: " . get_stylesheet_directory() . "\\n";
echo "stylesheet dir exists: " . (is_dir(get_stylesheet_directory()) ? 'YES' : 'NO') . "\\n";

// List available themes
$themes_dir = "$docroot/wp-content/themes/";
echo "\\nAvailable themes in $themes_dir:\\n";
if (is_dir($themes_dir)) {
  foreach (scandir($themes_dir) as $d) {
    if ($d === '.' || $d === '..') continue;
    if (is_dir("$themes_dir/$d")) {
      $has_style = file_exists("$themes_dir/$d/style.css") ? 'Y' : 'N';
      echo "  $d (style.css: $has_style)\\n";
    }
  }
}

// 2. Active plugins
echo "\\n=== ACTIVE PLUGINS ===\\n";
$plugins = get_option('active_plugins');
if (is_array($plugins)) {
  echo "Count: " . count($plugins) . "\\n";
  foreach ($plugins as $p) {
    $path = "$docroot/wp-content/plugins/$p";
    $exists = file_exists($path) ? 'EXISTS' : 'MISSING';
    echo "  $p ($exists)\\n";
  }
} else {
  echo "active_plugins: " . var_export($plugins, true) . "\\n";
}

// 3. Try actual page render
echo "\\n=== PAGE RENDER TEST ===\\n";
// Switch to a theme that exists
$current = wp_get_theme();
echo "Current theme: " . $current->get('Name') . " (exists: " . ($current->exists() ? 'Y' : 'N') . ")\\n";

// Try to render homepage
\$_SERVER['REQUEST_URI'] = '/';
\$_SERVER['REQUEST_METHOD'] = 'GET';
\$_SERVER['HTTP_HOST'] = 'playground.wordpress.net';
\$_SERVER['SERVER_NAME'] = 'playground.wordpress.net';
\$_SERVER['SERVER_PORT'] = '443';
\$_SERVER['HTTPS'] = 'on';

ob_start();
try {
  define('WP_USE_THEMES', true);
  // Load template
  wp();
  // Check query
  global $wp_query;
  echo "is_home: " . ($wp_query->is_home() ? 'Y' : 'N') . "\\n";
  echo "is_front_page: " . ($wp_query->is_front_page() ? 'Y' : 'N') . "\\n";
  echo "posts found: " . $wp_query->found_posts . "\\n";

  // Get template file
  $template_file = get_index_template();
  echo "index template: $template_file\\n";
  echo "template exists: " . (file_exists($template_file) ? 'Y' : 'N') . "\\n";

} catch (Throwable $e) {
  echo "Error: " . $e->getMessage() . "\\n";
  echo "File: " . $e->getFile() . ":" . $e->getLine() . "\\n";
}
$render_output = ob_get_clean();
if (strlen($render_output) > 0) {
  echo "Render output (" . strlen($render_output) . " bytes):\\n" . substr($render_output, 0, 1000) . "\\n";
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 8000), err: (r.errors ?? '').substring(0, 3000) };
  });

  console.log(result.text);
  if (result.err) console.log(`ERRORS: ${result.err}`);
});
