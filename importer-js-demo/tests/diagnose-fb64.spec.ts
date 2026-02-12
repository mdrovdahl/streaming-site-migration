import { test, expect } from '@playwright/test';

/**
 * Diagnostic: Test FROM_BASE64 support in Playground's SQLite layer,
 * and identify what specifically fails during wp_options import.
 */
test('FROM_BASE64 and wp_options import diagnostics', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Don't click Import yet — first test FROM_BASE64 natively
  const nativeTest = await page.evaluate(async () => {
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
$wpdb->show_errors(false);

echo "=== TEST 1: Native FROM_BASE64 in query ===\\n";
// Test if SQLite layer handles FROM_BASE64
$result = $wpdb->query("SELECT FROM_BASE64('dGVzdA==')");
echo "SELECT FROM_BASE64 result: " . var_export($result, true) . "\\n";
echo "Last error: " . $wpdb->last_error . "\\n";

echo "\\n=== TEST 2: INSERT with FROM_BASE64 values ===\\n";
// Create a test table
$wpdb->query("DROP TABLE IF EXISTS _test_fb64");
$wpdb->query("CREATE TABLE _test_fb64 (id INT, name TEXT, val TEXT)");
echo "Create table error: " . $wpdb->last_error . "\\n";

// Try INSERT with FROM_BASE64
$r2 = $wpdb->query("INSERT INTO _test_fb64 (id, name, val) VALUES (1, FROM_BASE64('dGVzdA=='), FROM_BASE64('dmFsdWU='))");
echo "INSERT with FROM_BASE64 result: " . var_export($r2, true) . "\\n";
echo "INSERT error: " . $wpdb->last_error . "\\n";

// Check what got inserted
$rows = $wpdb->get_results("SELECT * FROM _test_fb64", ARRAY_A);
echo "Rows: " . json_encode($rows) . "\\n";

echo "\\n=== TEST 3: INSERT with decoded values (what our decode does) ===\\n";
// This simulates what decode_from_base64 does: replaces FROM_BASE64('...') with decoded string
$r3 = $wpdb->query("INSERT INTO _test_fb64 (id, name, val) VALUES (2, 'test', 'value')");
echo "INSERT with decoded values result: " . var_export($r3, true) . "\\n";
echo "INSERT error: " . $wpdb->last_error . "\\n";

echo "\\n=== TEST 4: INSERT with special chars (simulating bad decode) ===\\n";
// Test with chars that could break after FROM_BASE64 decode
$special = "a string with 'quotes' and \\\\backslashes and \\0nulls";
$escaped = str_replace("'", "''", $special);
$r4 = $wpdb->query("INSERT INTO _test_fb64 (id, name, val) VALUES (3, 'special', '$escaped')");
echo "INSERT special chars result: " . var_export($r4, true) . "\\n";
echo "INSERT error: " . $wpdb->last_error . "\\n";

echo "\\n=== TEST 5: Multi-row INSERT like export produces ===\\n";
$r5 = $wpdb->query("INSERT INTO _test_fb64 (id, name, val) VALUES (10, 'row1', 'val1'),(11, 'row2', 'val2'),(12, 'row3', 'val3')");
echo "Multi-row INSERT result: " . var_export($r5, true) . "\\n";
echo "Multi-row error: " . $wpdb->last_error . "\\n";

echo "\\n=== TEST 6: Large multi-row INSERT (250 rows) ===\\n";
$values = [];
for ($i = 100; $i < 350; $i++) {
  $values[] = "($i, 'option_$i', 'value_$i')";
}
$big_query = "INSERT INTO _test_fb64 (id, name, val) VALUES " . implode(",", $values);
echo "Query size: " . strlen($big_query) . " bytes\\n";
$r6 = $wpdb->query($big_query);
echo "250-row INSERT result: " . var_export($r6, true) . "\\n";
echo "250-row error: " . $wpdb->last_error . "\\n";

$total = $wpdb->get_var("SELECT COUNT(*) FROM _test_fb64");
echo "Total rows in test table: $total\\n";

// Cleanup
$wpdb->query("DROP TABLE _test_fb64");

echo "\\n=== TEST 7: Check current wp_options min/max option_id ===\\n";
$min = $wpdb->get_var("SELECT MIN(option_id) FROM {$wpdb->options}");
$max = $wpdb->get_var("SELECT MAX(option_id) FROM {$wpdb->options}");
$count = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options}");
echo "Before import - option_id range: $min to $max, count: $count\\n";
$siteurl = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'siteurl'");
echo "siteurl before import: $siteurl\\n";
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 5000), err: (r.errors ?? '').substring(0, 2000) };
  });

  console.log('=== NATIVE TESTS (before import) ===');
  console.log(nativeTest.text);
  if (nativeTest.err) console.log(`ERRORS: ${nativeTest.err}`);

  // Now run the actual import
  await btnImport.click();
  const phaseBadge = page.locator('#phase-badge');
  await expect(phaseBadge).toHaveText(/DONE|ERROR/, { timeout: 4 * 60 * 1000 });

  // After import, check wp_options state and try to understand what failed
  const postImport = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    const r = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

$db_path = '${docroot}/wp-content/database/.ht.sqlite';
if (!file_exists($db_path)) {
  echo "DB file not found!\\n";
  exit;
}

$pdo = new PDO('sqlite:' . $db_path);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

echo "=== WP_OPTIONS AFTER IMPORT ===\\n";
$count = $pdo->query("SELECT COUNT(*) FROM wp_options")->fetchColumn();
echo "Total rows: $count\\n";

$min = $pdo->query("SELECT MIN(option_id) FROM wp_options")->fetchColumn();
$max = $pdo->query("SELECT MAX(option_id) FROM wp_options")->fetchColumn();
echo "option_id range: $min to $max\\n";

// Check for core options
$core_options = ['siteurl', 'home', 'blogname', 'blogdescription', 'admin_email', 'template', 'stylesheet'];
echo "\\nCore options:\\n";
foreach ($core_options as $opt) {
  $val = $pdo->query("SELECT option_value FROM wp_options WHERE option_name = " . $pdo->quote($opt))->fetchColumn();
  if ($val === false) {
    echo "  $opt: MISSING\\n";
  } else {
    echo "  $opt: " . substr($val, 0, 80) . "\\n";
  }
}

// Show first 5 and last 5 option_ids to understand the gap
echo "\\nFirst 5 rows:\\n";
$stmt = $pdo->query("SELECT option_id, option_name FROM wp_options ORDER BY option_id ASC LIMIT 5");
while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
  echo "  id={$row['option_id']} name={$row['option_name']}\\n";
}

echo "\\nLast 5 rows:\\n";
$stmt = $pdo->query("SELECT option_id, option_name FROM wp_options ORDER BY option_id DESC LIMIT 5");
while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
  echo "  id={$row['option_id']} name={$row['option_name']}\\n";
}

// Check another table's row count to verify import worked for other tables
echo "\\nOther table counts:\\n";
$tables = ['wp_posts', 'wp_users', 'wp_postmeta', 'wp_comments'];
foreach ($tables as $t) {
  try {
    $c = $pdo->query("SELECT COUNT(*) FROM $t")->fetchColumn();
    echo "  $t: $c rows\\n";
  } catch (Exception $e) {
    echo "  $t: ERROR - " . $e->getMessage() . "\\n";
  }
}
`,
    });
    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 5000), err: (r.errors ?? '').substring(0, 2000) };
  });

  console.log('\n=== POST-IMPORT STATE ===');
  console.log(postImport.text);
  if (postImport.err) console.log(`ERRORS: ${postImport.err}`);
});
