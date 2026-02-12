import { test, expect } from '@playwright/test';

test('check SQLite tables before and after import', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Check tables BEFORE import
  const before = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;
    const r = await pg.run({
      code: `<?php
define('WP_INSTALLING', true);
ob_start();
require_once '${docroot}/wp-load.php';
ob_end_clean();

global $wpdb;
$wpdb->suppress_errors(true);

// List all SQLite tables
$tables = $wpdb->get_results("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", ARRAY_N);
echo "Tables before import:\\n";
foreach ($tables as $row) {
  echo "  " . $row[0] . "\\n";
}

// Check options table
$count = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options}");
echo "wp_options count: $count\\n";

// Check if blog is installed
echo "is_blog_installed: " . (is_blog_installed() ? 'yes' : 'no') . "\\n";
`,
    });
    return { text: (r.text ?? '').substring(0, 3000), err: (r.errors ?? '').substring(0, 500) };
  });

  console.log('\n=== BEFORE Import ===');
  console.log(before.text);

  // Run import
  await btnImport.click();
  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });
  const badge = await phaseBadge.textContent();
  console.log(`\nImport result: ${badge}`);

  // Check tables AFTER import
  const after = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;
    const r = await pg.run({
      code: `<?php
define('WP_INSTALLING', true);
ob_start();
require_once '${docroot}/wp-load.php';
ob_end_clean();

global $wpdb;
$wpdb->suppress_errors(true);

// List all SQLite tables
$tables = $wpdb->get_results("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", ARRAY_N);
echo "Tables after import:\\n";
foreach ($tables as $row) {
  echo "  " . $row[0] . "\\n";
}

// Check key tables exist
$key_tables = ['wp_options', 'wp_posts', 'wp_users', 'wp_usermeta', 'wp_postmeta', 'wp_terms', 'wp_comments'];
foreach ($key_tables as $tbl) {
  $count = $wpdb->get_var("SELECT COUNT(*) FROM $tbl");
  $err = $wpdb->last_error;
  if ($err) {
    echo "$tbl: ERROR - $err\\n";
  } else {
    echo "$tbl: $count rows\\n";
  }
}

// Check siteurl
$siteurl = $wpdb->get_var("SELECT option_value FROM wp_options WHERE option_name = 'siteurl'");
echo "siteurl: $siteurl\\n";

// Try is_blog_installed
echo "is_blog_installed: " . (is_blog_installed() ? 'yes' : 'no') . "\\n";
`,
    });
    return { text: (r.text ?? '').substring(0, 3000), err: (r.errors ?? '').substring(0, 500) };
  });

  console.log('\n=== AFTER Import ===');
  console.log(after.text);
  if (after.err) console.log(`Errors: ${after.err}`);

  expect(after.text).toContain('is_blog_installed: yes');
});
