import { test, expect } from '@playwright/test';

test('check db.php before and after import', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Check db.php BEFORE import
  const before = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    const r = await pg.run({
      code: `<?php
$docroot = '${docroot}';
echo "docroot: $docroot\\n";
echo "db.php exists: " . (file_exists("$docroot/wp-content/db.php") ? 'yes' : 'no') . "\\n";
echo "db.php size: " . (file_exists("$docroot/wp-content/db.php") ? filesize("$docroot/wp-content/db.php") : 'N/A') . "\\n";

// List wp-content/ top-level files
$items = scandir("$docroot/wp-content/");
echo "wp-content/ items: " . implode(', ', array_diff($items, ['.', '..'])) . "\\n";

// Check for db.php in other locations
echo "/internal/shared/sqlite-database-integration exists: " .
  (is_dir('/internal/shared/sqlite-database-integration') ? 'yes' : 'no') . "\\n";

// Check if db.php is a symlink
echo "db.php is symlink: " . (is_link("$docroot/wp-content/db.php") ? 'yes' : 'no') . "\\n";

// Scan for all db.php files
function findDbPhp($dir, $depth = 0) {
  if ($depth > 3) return [];
  $results = [];
  foreach (scandir($dir) as $item) {
    if ($item === '.' || $item === '..') continue;
    $path = "$dir/$item";
    if ($item === 'db.php') {
      $results[] = $path . ' (' . filesize($path) . ' bytes)';
    }
    if (is_dir($path) && !is_link($path)) {
      $results = array_merge($results, findDbPhp($path, $depth + 1));
    }
  }
  return $results;
}
$found = findDbPhp($docroot);
echo "db.php files found: " . (empty($found) ? 'none' : implode('; ', $found)) . "\\n";

// Try loading WP to see if it works before import
ob_start();
define('WP_INSTALLING', true);
require_once "$docroot/wp-load.php";
ob_end_clean();
echo "WP loaded OK before import\\n";
echo "Active theme: " . get_option('template') . "\\n";
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 3000), err: (r.errors ?? '').substring(0, 500) };
  });

  console.log('\n=== BEFORE Import ===');
  console.log(`Exit: ${before.exit}`);
  console.log(before.text);
  if (before.err) console.log(`Errors: ${before.err}`);

  // Now run import
  await btnImport.click();
  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });

  // Check db.php AFTER import
  const after = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    const r = await pg.run({
      code: `<?php
$docroot = '${docroot}';
echo "db.php exists: " . (file_exists("$docroot/wp-content/db.php") ? 'yes' : 'no') . "\\n";
echo "db.php size: " . (file_exists("$docroot/wp-content/db.php") ? filesize("$docroot/wp-content/db.php") : 'N/A') . "\\n";
echo "db.php is symlink: " . (is_link("$docroot/wp-content/db.php") ? 'yes' : 'no') . "\\n";

// List wp-content/ top-level files
$items = scandir("$docroot/wp-content/");
echo "wp-content/ items: " . implode(', ', array_diff($items, ['.', '..'])) . "\\n";

// Check if the SQLite DB file still exists
echo "database/ dir exists: " . (is_dir("$docroot/wp-content/database") ? 'yes' : 'no') . "\\n";
if (is_dir("$docroot/wp-content/database")) {
  $dbfiles = scandir("$docroot/wp-content/database");
  echo "database/ contents: " . implode(', ', array_diff($dbfiles, ['.', '..'])) . "\\n";
}

// Try to load WP
define('WP_INSTALLING', true);
ob_start();
require_once "$docroot/wp-load.php";
$output = ob_get_clean();
if (strpos($output, 'Error') !== false) {
  echo "WP load error: " . substr($output, strpos($output, '<div class=\"wp-die-message\">'), 200) . "\\n";
} else {
  echo "WP loaded OK\\n";
  echo "Active theme: " . get_option('template') . "\\n";
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 3000), err: (r.errors ?? '').substring(0, 500) };
  });

  console.log('\n=== AFTER Import ===');
  console.log(`Exit: ${after.exit}`);
  console.log(after.text);
  if (after.err) console.log(`Errors: ${after.err}`);

  expect(before.text).toContain('db.php exists: yes');
});
