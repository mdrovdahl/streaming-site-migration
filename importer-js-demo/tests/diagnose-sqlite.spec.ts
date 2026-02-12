import { test, expect } from '@playwright/test';

test('query SQLite directly after import', async ({ page }) => {
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

    // Query SQLite database directly, bypassing WordPress
    const r = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

// Open SQLite database directly
$db_path = '${docroot}/wp-content/database/.ht.sqlite';
echo "DB path: $db_path\\n";
echo "DB exists: " . (file_exists($db_path) ? 'yes' : 'no') . "\\n";
echo "DB size: " . (file_exists($db_path) ? filesize($db_path) . ' bytes' : 'N/A') . "\\n";

if (!file_exists($db_path)) {
  echo "No database file found!\\n";
  // Check other possible locations
  $locations = [
    '${docroot}/wp-content/database/',
    '${docroot}/wp-content/',
    '/tmp/',
  ];
  foreach ($locations as $dir) {
    if (is_dir($dir)) {
      echo "Contents of $dir: " . implode(', ', array_diff(scandir($dir), ['.', '..'])) . "\\n";
    }
  }
  exit;
}

try {
  $pdo = new PDO('sqlite:' . $db_path);
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

  // List all tables
  $stmt = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);
  echo "\\nTables (" . count($tables) . "):\\n";
  foreach ($tables as $tbl) {
    echo "  $tbl\\n";
  }

  // Check key WordPress tables
  $key_tables = ['wp_options', 'wp_posts', 'wp_users', 'wp_usermeta', 'wp_postmeta'];
  echo "\\nKey table row counts:\\n";
  foreach ($key_tables as $tbl) {
    try {
      $count = $pdo->query("SELECT COUNT(*) FROM $tbl")->fetchColumn();
      echo "  $tbl: $count rows\\n";
    } catch (Exception $e) {
      echo "  $tbl: ERROR - " . $e->getMessage() . "\\n";
    }
  }

  // Check _wp_sqlite_* tables
  echo "\\nSQLite driver internal tables:\\n";
  foreach ($tables as $tbl) {
    if (strpos($tbl, '_wp_sqlite_') === 0) {
      try {
        $count = $pdo->query("SELECT COUNT(*) FROM \\\"$tbl\\\"")->fetchColumn();
        echo "  $tbl: $count rows\\n";
      } catch (Exception $e) {
        echo "  $tbl: ERROR - " . $e->getMessage() . "\\n";
      }
    }
  }

  // Sample from wp_options
  echo "\\nwp_options sample:\\n";
  try {
    $stmt = $pdo->query("SELECT option_name, substr(option_value, 1, 80) FROM wp_options LIMIT 10");
    while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
      echo "  {$row[0]}: {$row[1]}\\n";
    }
  } catch (Exception $e) {
    echo "  ERROR: " . $e->getMessage() . "\\n";
  }

} catch (Exception $e) {
  echo "PDO Error: " . $e->getMessage() . "\\n";
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 5000), err: (r.errors ?? '').substring(0, 1000) };
  });

  console.log(result.text);
  if (result.err) console.log(`Errors: ${result.err}`);

  expect(result.text).toContain('wp_options');
});
