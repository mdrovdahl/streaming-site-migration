import { test, expect } from '@playwright/test';

test('dig into PDO handle for FROM_BASE64 UDF', async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    const r = await pg.run({
      code: `<?php
function _import_noop_die($msg = '', $title = '', $args = []) {}
function _import_return_noop_die() { return '_import_noop_die'; }
if (function_exists('playground_add_filter')) {
  playground_add_filter('wp_die_handler', '_import_return_noop_die');
}

define('WP_INSTALLING', true);
ob_start();
require_once '${docroot}/wp-load.php';
ob_end_clean();

global $wpdb;

$driver = $wpdb->dbh;
echo "driver class: " . get_class($driver) . "\\n";

$ref = new ReflectionObject($driver);
$prop = $ref->getProperty('mysql_on_sqlite_driver');
$prop->setAccessible(true);
$pdo_like = $prop->getValue($driver);
echo "pdo_like class: " . get_class($pdo_like) . "\\n";
echo "pdo_like instanceof PDO: " . ($pdo_like instanceof PDO ? 'YES' : 'no') . "\\n";

// Check PDO driver name
try {
  $driver_name = $pdo_like->getAttribute(PDO::ATTR_DRIVER_NAME);
  echo "PDO driver: $driver_name\\n";
} catch (Throwable $e) {
  echo "PDO driver error: " . $e->getMessage() . "\\n";
}

// Explore WP_PDO_MySQL_On_SQLite properties for a real SQLite PDO
$ref2 = new ReflectionObject($pdo_like);
echo "\\nWP_PDO_MySQL_On_SQLite properties:\\n";
foreach ($ref2->getProperties() as $p) {
  $p->setAccessible(true);
  try {
    $v = $p->getValue($pdo_like);
    $type = is_object($v) ? get_class($v) : gettype($v);
    $isPDO = ($v instanceof PDO) ? ' [IS PDO!]' : '';
    echo "  {$p->getName()}: $type$isPDO\\n";
  } catch (Throwable $e) {
    echo "  {$p->getName()}: ERROR - " . $e->getMessage() . "\\n";
  }
}

// Check parent class
$parent = $ref2->getParentClass();
echo "\\nParent class: " . ($parent ? $parent->getName() : 'none') . "\\n";

// Try sqliteCreateFunction on the WP_PDO_MySQL_On_SQLite
echo "\\n=== Trying sqliteCreateFunction ===\\n";
try {
  $ok = $pdo_like->sqliteCreateFunction('FROM_BASE64', 'base64_decode', 1);
  echo "Result: " . var_export($ok, true) . "\\n";

  // Test it
  $wpdb->suppress_errors(false);
  $r1 = $wpdb->get_var("SELECT FROM_BASE64('dGVzdA==')");
  echo "SELECT FROM_BASE64 = " . var_export($r1, true) . "\\n";
  echo "Error: " . $wpdb->last_error . "\\n";
} catch (Throwable $e) {
  echo "Error: " . get_class($e) . ": " . $e->getMessage() . "\\n";

  // Maybe the real SQLite PDO is the parent
  echo "\\nTrying to call on parent (PDO) class...\\n";
  try {
    // If WP_PDO_MySQL_On_SQLite overrides methods but the parent PDO is SQLite,
    // we can try calling the parent method directly
    $parentRef = new ReflectionMethod('PDO', 'sqliteCreateFunction');
    // This won't work because the method is native, not PHP

    // Alternative: try constructing a NEW PDO to the same SQLite file
    echo "\\nLooking for SQLite file path...\\n";
    // Check all properties for a file path
    foreach ($ref2->getProperties() as $p) {
      $p->setAccessible(true);
      try {
        $v = $p->getValue($pdo_like);
        if (is_string($v) && (strpos($v, 'sqlite') !== false || strpos($v, '.ht.sqlite') !== false)) {
          echo "  Found path in {$p->getName()}: $v\\n";
        }
      } catch (Throwable $e) {}
    }

    // Try getting DSN
    echo "\\nAlternative: Open separate PDO to same SQLite file\\n";
    $db_path = '${docroot}/wp-content/database/.ht.sqlite';
    echo "DB path: $db_path (exists: " . (file_exists($db_path) ? 'yes' : 'no') . ")\\n";

    if (file_exists($db_path)) {
      $sqlite_pdo = new PDO('sqlite:' . $db_path);
      $sqlite_pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
      $sqlite_pdo->sqliteCreateFunction('FROM_BASE64', 'base64_decode', 1);
      echo "Registered on separate PDO connection\\n";

      // Test on separate connection
      $val = $sqlite_pdo->query("SELECT FROM_BASE64('dGVzdA==')")->fetchColumn();
      echo "Separate PDO: FROM_BASE64('dGVzdA==') = $val\\n";

      // But does this help wpdb? No - different connection.
      echo "NOTE: This is a separate connection, won't help wpdb\\n";
    }
  } catch (Throwable $e2) {
    echo "Error: " . $e2->getMessage() . "\\n";
  }
}

// Alternative approach: check if WP_PDO_MySQL_On_SQLite has a method to execute raw SQLite
echo "\\n=== WP_PDO_MySQL_On_SQLite methods ===\\n";
foreach ($ref2->getMethods() as $m) {
  if ($m->class === $ref2->getName()) {
    echo "  " . $m->getName() . "()\\n";
  }
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 8000), err: (r.errors ?? '').substring(0, 3000) };
  });

  console.log(result.text);
  if (result.err) console.log(`ERRORS: ${result.err}`);
});
