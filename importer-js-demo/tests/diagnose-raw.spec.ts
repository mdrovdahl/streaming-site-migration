import { test, expect } from '@playwright/test';

test('raw SQLite state after import', async ({ page }) => {
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

    // Query SQLite directly - NO WordPress loading
    const r = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

$docroot = '${docroot}';

// 1. Find the SQLite database file
$possible = [
  "$docroot/wp-content/database/.ht.sqlite",
  "$docroot/wp-content/db.sqlite",
];
$db_path = null;
foreach ($possible as $p) {
  if (file_exists($p)) { $db_path = $p; break; }
}

// Also scan database/ dir
$db_dir = "$docroot/wp-content/database/";
echo "=== DATABASE FILE ===\\n";
if (is_dir($db_dir)) {
  echo "database/ dir: ";
  $files = array_diff(scandir($db_dir), ['.', '..']);
  echo implode(', ', $files) . "\\n";
} else {
  echo "database/ dir: MISSING\\n";
}
echo "DB path: " . ($db_path ?? 'NOT FOUND') . "\\n";
if ($db_path) {
  echo "DB size: " . filesize($db_path) . " bytes\\n";
}

// 2. Check db.php
echo "\\n=== DB.PHP ===\\n";
$dbphp = "$docroot/wp-content/db.php";
echo "exists: " . (file_exists($dbphp) ? 'yes' : 'no') . "\\n";
if (file_exists($dbphp)) {
  echo "size: " . filesize($dbphp) . "\\n";
  echo "first line: " . trim(fgets(fopen($dbphp, 'r'))) . "\\n";
}

if (!$db_path) {
  echo "\\nCannot query - no database file!\\n";
  exit;
}

// 3. Open SQLite directly
$pdo = new PDO('sqlite:' . $db_path);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

// 4. List ALL tables
echo "\\n=== ALL SQLITE TABLES ===\\n";
$tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
echo "Count: " . count($tables) . "\\n";
foreach ($tables as $t) {
  echo "  $t\\n";
}

// 5. Check wp_options specifically
echo "\\n=== WP_OPTIONS ===\\n";
try {
  $count = $pdo->query("SELECT COUNT(*) FROM wp_options")->fetchColumn();
  echo "Row count: $count\\n";

  // Check autoload values
  $stmt = $pdo->query("SELECT autoload, COUNT(*) as c FROM wp_options GROUP BY autoload");
  echo "Autoload distribution:\\n";
  while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
    echo "  '{$row['autoload']}': {$row['c']} rows\\n";
  }

  // Check siteurl
  $siteurl = $pdo->query("SELECT option_value FROM wp_options WHERE option_name = 'siteurl'")->fetchColumn();
  echo "siteurl: $siteurl\\n";

  // Check blogname
  $name = $pdo->query("SELECT option_value FROM wp_options WHERE option_name = 'blogname'")->fetchColumn();
  echo "blogname: $name\\n";

} catch (Exception $e) {
  echo "ERROR: " . $e->getMessage() . "\\n";
}

// 6. PRAGMA table_info for wp_options
echo "\\n=== PRAGMA TABLE_INFO(wp_options) ===\\n";
try {
  $info = $pdo->query("PRAGMA table_info(wp_options)")->fetchAll(PDO::FETCH_ASSOC);
  foreach ($info as $col) {
    echo "  {$col['name']} ({$col['type']})\\n";
  }
} catch (Exception $e) {
  echo "ERROR: " . $e->getMessage() . "\\n";
}

// 7. Check _wp_sqlite tables
echo "\\n=== _WP_SQLITE INTERNAL TABLES ===\\n";
foreach ($tables as $t) {
  if (strpos($t, '_wp_sqlite') === 0) {
    $count = $pdo->query("SELECT COUNT(*) FROM \\"$t\\"")->fetchColumn();
    echo "  $t: $count rows\\n";
  }
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 5000), err: (r.errors ?? '').substring(0, 1000) };
  });

  console.log(result.text);
  if (result.err) console.log(`ERRORS: ${result.err}`);
});
