import { test, expect } from '@playwright/test';

test('find SQLite connection and test alternatives', async ({ page }) => {
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
$wpdb->suppress_errors(false);

// Explore WP_SQLite_Connection
$driver = $wpdb->dbh;
$ref = new ReflectionObject($driver);
$prop = $ref->getProperty('mysql_on_sqlite_driver');
$prop->setAccessible(true);
$pdo_like = $prop->getValue($driver);

$ref2 = new ReflectionObject($pdo_like);
$conn_prop = $ref2->getProperty('connection');
$conn_prop->setAccessible(true);
$connection = $conn_prop->getValue($pdo_like);

echo "=== WP_SQLite_Connection ===\\n";
echo "Class: " . get_class($connection) . "\\n";
$ref3 = new ReflectionObject($connection);
echo "Properties:\\n";
foreach ($ref3->getProperties() as $p) {
  $p->setAccessible(true);
  try {
    $v = $p->getValue($connection);
    $type = is_object($v) ? get_class($v) : gettype($v);
    $isPDO = ($v instanceof PDO) ? ' [IS PDO!]' : '';
    echo "  {$p->getName()}: $type$isPDO\\n";
    if (is_string($v) && strlen($v) < 200) echo "    = $v\\n";
  } catch (Throwable $e) {
    echo "  {$p->getName()}: ERROR\\n";
  }
}
echo "Methods:\\n";
foreach ($ref3->getMethods() as $m) {
  if ($m->class === $ref3->getName()) {
    echo "  " . $m->getName() . "()\\n";
  }
}

// Try to get to the actual PDO SQLite connection
// Maybe WP_SQLite_Connection holds the real PDO
echo "\\n=== Trying to find real SQLite PDO ===\\n";
$found_pdo = null;
foreach ($ref3->getProperties() as $p) {
  $p->setAccessible(true);
  try {
    $v = $p->getValue($connection);
    if ($v instanceof PDO) {
      $found_pdo = $v;
      echo "Found PDO in WP_SQLite_Connection->{$p->getName()}\\n";
      $dn = $v->getAttribute(PDO::ATTR_DRIVER_NAME);
      echo "Driver: $dn\\n";
      // Try sqliteCreateFunction
      try {
        $ok = $v->sqliteCreateFunction('FROM_BASE64', 'base64_decode', 1);
        echo "sqliteCreateFunction on real PDO: " . var_export($ok, true) . "\\n";
        // Test it through wpdb
        $r1 = $wpdb->get_var("SELECT FROM_BASE64('dGVzdA==')");
        echo "FROM_BASE64 via wpdb: " . var_export($r1, true) . "\\n";
      } catch (Throwable $e) {
        echo "sqliteCreateFunction error: " . $e->getMessage() . "\\n";
      }
      break;
    }
  } catch (Throwable $e) {}
}

// Check if function_exists works for PDO methods
echo "\\n=== PDO method availability ===\\n";
echo "method_exists PDO sqliteCreateFunction: " . var_export(method_exists('PDO', 'sqliteCreateFunction'), true) . "\\n";
echo "PHP extensions: " . implode(', ', array_filter(get_loaded_extensions(), function($e) {
  return stripos($e, 'sqlite') !== false || stripos($e, 'pdo') !== false;
})) . "\\n";

// Alternative approach: CAST(X'hex' AS TEXT)
echo "\\n=== Alternative: CAST(X'hex' AS TEXT) ===\\n";
$wpdb->query("DROP TABLE IF EXISTS _test_hex");
$wpdb->query("CREATE TABLE _test_hex (id INT, val TEXT)");

// Test with normal string
$hex_hello = bin2hex('hello world');
$r1 = $wpdb->query("INSERT INTO _test_hex (id, val) VALUES (1, CAST(X'$hex_hello' AS TEXT))");
echo "CAST(X'hex' AS TEXT) result: " . var_export($r1, true) . "\\n";
echo "Error: " . $wpdb->last_error . "\\n";

// Test with null bytes
$val_with_null = "before\\x00after";
$hex_null = bin2hex($val_with_null);
$r2 = $wpdb->query("INSERT INTO _test_hex (id, val) VALUES (2, CAST(X'$hex_null' AS TEXT))");
echo "Null-byte hex INSERT result: " . var_export($r2, true) . "\\n";
echo "Error: " . $wpdb->last_error . "\\n";

// Read back
$v1 = $wpdb->get_var("SELECT val FROM _test_hex WHERE id = 1");
echo "Read back 1: $v1\\n";
$v2 = $wpdb->get_var("SELECT val FROM _test_hex WHERE id = 2");
echo "Read back 2 hex: " . bin2hex($v2 ?? '') . "\\n";
echo "Expected hex:    " . bin2hex($val_with_null) . "\\n";

// Alternative: use unhex if available
echo "\\n=== Alternative: UNHEX() function ===\\n";
try {
  $r3 = $wpdb->get_var("SELECT UNHEX('68656c6c6f')");
  echo "UNHEX available: " . ($r3 !== null ? 'YES = ' . $r3 : 'no') . "\\n";
} catch (Throwable $e) {
  echo "UNHEX error: " . $e->getMessage() . "\\n";
}
echo "UNHEX error: " . $wpdb->last_error . "\\n";

// Alternative: just strip null bytes before embedding (lossy but might be OK for text columns)
echo "\\n=== Alternative: Strip null bytes ===\\n";
$serialized = 'a:1:{s:7:"' . "\\x00" . 'Foo' . "\\x00" . 'x";s:3:"bar";}';
$stripped = str_replace("\\x00", '', $serialized);
$escaped = str_replace("'", "''", $stripped);
$r4 = $wpdb->query("INSERT INTO _test_hex (id, val) VALUES (3, '$escaped')");
echo "Stripped null INSERT: " . var_export($r4, true) . "\\n";
echo "Error: " . $wpdb->last_error . "\\n";
$v3 = $wpdb->get_var("SELECT val FROM _test_hex WHERE id = 3");
echo "Read back 3: " . bin2hex($v3 ?? '') . "\\n";

$wpdb->query("DROP TABLE IF EXISTS _test_hex");
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 8000), err: (r.errors ?? '').substring(0, 2000) };
  });

  console.log(result.text);
  if (result.err) console.log(`ERRORS: ${result.err}`);
});
