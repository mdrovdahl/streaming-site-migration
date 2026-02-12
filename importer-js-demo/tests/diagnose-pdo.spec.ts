import { test, expect } from '@playwright/test';

/**
 * Explore wpdb's internal PDO handle so we can register FROM_BASE64 UDF.
 */
test('find PDO handle and register FROM_BASE64 UDF', async ({ page }) => {
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

echo "=== WPDB CLASS CHAIN ===\\n";
echo "wpdb class: " . get_class($wpdb) . "\\n";
echo "dbh type: " . (is_object($wpdb->dbh) ? get_class($wpdb->dbh) : gettype($wpdb->dbh)) . "\\n";
echo "dbh is PDO: " . ($wpdb->dbh instanceof PDO ? 'YES' : 'no') . "\\n";

// Explore dbh properties
$driver = $wpdb->dbh;
if (is_object($driver)) {
  $ref = new ReflectionObject($driver);
  echo "\\n=== DRIVER PROPERTIES ===\\n";
  foreach ($ref->getProperties() as $prop) {
    $prop->setAccessible(true);
    $val = $prop->getValue($driver);
    $type = is_object($val) ? get_class($val) : gettype($val);
    $isPDO = ($val instanceof PDO) ? ' [IS PDO!]' : '';
    echo "  {$prop->getName()}: $type$isPDO\\n";

    // Go one level deeper for objects
    if (is_object($val) && !($val instanceof PDO)) {
      $ref2 = new ReflectionObject($val);
      foreach ($ref2->getProperties() as $prop2) {
        $prop2->setAccessible(true);
        try {
          $val2 = $prop2->getValue($val);
          $type2 = is_object($val2) ? get_class($val2) : gettype($val2);
          $isPDO2 = ($val2 instanceof PDO) ? ' [IS PDO!]' : '';
          echo "    {$prop2->getName()}: $type2$isPDO2\\n";

          // One more level
          if (is_object($val2) && !($val2 instanceof PDO)) {
            $ref3 = new ReflectionObject($val2);
            foreach ($ref3->getProperties() as $prop3) {
              $prop3->setAccessible(true);
              try {
                $val3 = $prop3->getValue($val2);
                $type3 = is_object($val3) ? get_class($val3) : gettype($val3);
                $isPDO3 = ($val3 instanceof PDO) ? ' [IS PDO!]' : '';
                echo "      {$prop3->getName()}: $type3$isPDO3\\n";
              } catch (Throwable $e) {
                echo "      {$prop3->getName()}: ERROR\\n";
              }
            }
          }
        } catch (Throwable $e) {
          echo "    {$prop2->getName()}: ERROR\\n";
        }
      }
    }
  }
}

// Try to register FROM_BASE64 UDF by finding PDO
echo "\\n=== REGISTERING FROM_BASE64 UDF ===\\n";
$pdo = null;

// Strategy 1: dbh is PDO directly
if ($wpdb->dbh instanceof PDO) {
  $pdo = $wpdb->dbh;
  echo "Found PDO: dbh directly\\n";
}

// Strategy 2: search recursively through properties
if (!$pdo) {
  $search = [$wpdb->dbh];
  $visited = [];
  $found_path = '';

  while (!empty($search) && !$pdo) {
    $obj = array_shift($search);
    if (!is_object($obj)) continue;

    $oid = spl_object_id($obj);
    if (isset($visited[$oid])) continue;
    $visited[$oid] = true;

    if ($obj instanceof PDO) {
      $pdo = $obj;
      $found_path = get_class($obj);
      break;
    }

    $ref = new ReflectionObject($obj);
    foreach ($ref->getProperties() as $prop) {
      $prop->setAccessible(true);
      try {
        $val = $prop->getValue($obj);
        if ($val instanceof PDO) {
          $pdo = $val;
          $found_path = get_class($obj) . '->' . $prop->getName();
          break 2;
        }
        if (is_object($val)) {
          $search[] = $val;
        }
      } catch (Throwable $e) {}
    }
  }

  if ($pdo) {
    echo "Found PDO via: $found_path\\n";
  } else {
    echo "PDO not found in object chain!\\n";
  }
}

if ($pdo) {
  // Register FROM_BASE64
  $ok = $pdo->sqliteCreateFunction('FROM_BASE64', 'base64_decode', 1);
  echo "sqliteCreateFunction result: " . var_export($ok, true) . "\\n";

  // Test it
  $wpdb->suppress_errors(false);

  // Test SELECT
  $r1 = $wpdb->get_var("SELECT FROM_BASE64('dGVzdA==')");
  echo "SELECT FROM_BASE64('dGVzdA==') = " . var_export($r1, true) . "\\n";
  echo "Error: " . $wpdb->last_error . "\\n";

  // Test INSERT with FROM_BASE64
  $wpdb->query("DROP TABLE IF EXISTS _test_udf");
  $wpdb->query("CREATE TABLE _test_udf (id INT, name TEXT, val TEXT)");
  $r2 = $wpdb->query("INSERT INTO _test_udf (id, name, val) VALUES (1, FROM_BASE64('dGVzdA=='), FROM_BASE64('dmFsdWU='))");
  echo "INSERT with FROM_BASE64 result: " . var_export($r2, true) . "\\n";
  echo "INSERT error: " . $wpdb->last_error . "\\n";

  // Test with value containing null bytes (PHP serialized data)
  // \\x00 is null byte used in PHP serialized private properties
  $data_with_null = base64_encode("a:1:{s:7:\\"\\x00Foo\\x00x\\";s:3:\\"bar\\";}");
  echo "\\nTest with null-byte value (base64): $data_with_null\\n";
  $r3 = $wpdb->query("INSERT INTO _test_udf (id, name, val) VALUES (2, 'null_test', FROM_BASE64('$data_with_null'))");
  echo "INSERT null-byte via FROM_BASE64 result: " . var_export($r3, true) . "\\n";
  echo "INSERT error: " . $wpdb->last_error . "\\n";

  // Read it back
  $readback = $wpdb->get_var("SELECT val FROM _test_udf WHERE id = 2");
  echo "Read back value bytes: " . bin2hex($readback ?? '') . "\\n";
  echo "Expected bytes:        " . bin2hex("a:1:{s:7:\\"\\x00Foo\\x00x\\";s:3:\\"bar\\";}") . "\\n";

  // Now test what fails with the decode approach (embedding null bytes in SQL)
  echo "\\n=== Compare: decoded null-byte embedded in SQL ===\\n";
  $decoded = base64_decode($data_with_null);
  $escaped = str_replace("'", "''", $decoded);
  $r4 = $wpdb->query("INSERT INTO _test_udf (id, name, val) VALUES (3, 'null_decoded', '$escaped')");
  echo "INSERT with decoded null in SQL: " . var_export($r4, true) . "\\n";
  echo "Error: " . $wpdb->last_error . "\\n";

  $readback2 = $wpdb->get_var("SELECT val FROM _test_udf WHERE id = 3");
  echo "Read back decoded bytes: " . bin2hex($readback2 ?? '') . "\\n";

  $wpdb->query("DROP TABLE IF EXISTS _test_udf");
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 8000), err: (r.errors ?? '').substring(0, 2000) };
  });

  console.log(result.text);
  if (result.err) console.log(`ERRORS: ${result.err}`);
});
