import { test, expect } from '@playwright/test';

test('diagnose filesystem after import', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // First check BEFORE import
  const preImport = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;
    const r = await pg.run({
      code: `<?php
echo "docroot: ${docroot}\\n";
echo "WP_CONTENT_DIR: " . (defined('WP_CONTENT_DIR') ? WP_CONTENT_DIR : 'not defined') . "\\n";

$themes = "${docroot}/wp-content/themes";
echo "\\nThemes dir ($themes):\\n";
if (is_dir($themes)) {
  foreach (scandir($themes) as $d) {
    if ($d === '.' || $d === '..') continue;
    echo "  $d/\\n";
  }
} else {
  echo "  DIR DOES NOT EXIST\\n";
}

$plugins = "${docroot}/wp-content/plugins";
echo "\\nPlugins dir ($plugins):\\n";
if (is_dir($plugins)) {
  foreach (scandir($plugins) as $d) {
    if ($d === '.' || $d === '..') continue;
    echo "  $d\\n";
  }
}
`,
    });
    return (r.text ?? '').substring(0, 3000);
  });
  console.log('=== BEFORE IMPORT ===');
  console.log(preImport);

  // Run import
  await btnImport.click();
  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });

  // Check AFTER import
  const postImport = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;
    const r = await pg.run({
      code: `<?php
$themes = "${docroot}/wp-content/themes";
echo "Themes dir ($themes):\\n";
if (is_dir($themes)) {
  $entries = scandir($themes);
  $dirs = array_filter($entries, function($d) use ($themes) {
    return $d !== '.' && $d !== '..' && is_dir("$themes/$d");
  });
  if (empty($dirs)) {
    echo "  EMPTY - no theme directories!\\n";
  }
  foreach ($dirs as $d) {
    echo "  $d/\\n";
  }
} else {
  echo "  DIR DOES NOT EXIST\\n";
}

$plugins = "${docroot}/wp-content/plugins";
echo "\\nPlugins dir ($plugins):\\n";
if (is_dir($plugins)) {
  $entries = scandir($plugins);
  foreach ($entries as $d) {
    if ($d === '.' || $d === '..') continue;
    echo "  $d\\n";
  }
} else {
  echo "  DIR DOES NOT EXIST\\n";
}

// Check wp-content top level
$wpcontent = "${docroot}/wp-content";
echo "\\nwp-content contents:\\n";
foreach (scandir($wpcontent) as $d) {
  if ($d === '.' || $d === '..') continue;
  $type = is_dir("$wpcontent/$d") ? 'dir' : 'file';
  echo "  $d ($type)\\n";
}

// Check wp-config.php for WP_CONTENT_DIR
echo "\\nwp-config.php WP_CONTENT_DIR:\\n";
$config = file_get_contents("${docroot}/wp-config.php");
if (preg_match('/WP_CONTENT_DIR/', $config)) {
  echo "  Found WP_CONTENT_DIR in config\\n";
  // Show relevant line
  foreach (explode("\\n", $config) as $line) {
    if (strpos($line, 'WP_CONTENT') !== false) {
      echo "  $line\\n";
    }
  }
} else {
  echo "  Not set in wp-config.php\\n";
}
`,
    });
    return (r.text ?? '').substring(0, 3000);
  });
  console.log('\n=== AFTER IMPORT ===');
  console.log(postImport);
});
