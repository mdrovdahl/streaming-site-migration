import { test, expect } from '@playwright/test';

/**
 * Diagnostic: try executing SQL through the same path as playground-sink.ts
 */
test('diagnose SQL execution in Playground', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser]', msg.text());
  });

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  async function runPhp(code: string) {
    return page.evaluate(async (phpCode) => {
      const pg = (window as any).__playground;
      const docRoot = await pg.documentRoot;
      const finalCode = phpCode.replace(/\{\{DOCROOT\}\}/g, docRoot);
      const result = await pg.run({ code: finalCode });
      return {
        exitCode: result.exitCode,
        stdout: result.text ?? '',
        stderr: result.errors ?? '',
      };
    }, code);
  }

  // Step 1: Try a simple $wpdb->query()
  const simple = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '{{DOCROOT}}/wp-load.php';
global $wpdb;
$result = $wpdb->query("SELECT 1");
echo "Simple query result: " . var_export($result, true) . "\\n";
echo "Last error: " . $wpdb->last_error . "\\n";
`);
  console.log('\n=== Step 1: Simple wpdb query ===');
  console.log('Exit:', simple.exitCode);
  console.log(simple.stdout);
  if (simple.stderr) console.log('Stderr:', simple.stderr);

  // Step 2: Try typical MySQL DDL that would come from a dump
  const ddl = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '{{DOCROOT}}/wp-load.php';
global $wpdb;

$queries = [
  "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'",
  "SET time_zone = '+00:00'",
  "SET NAMES utf8mb4",
  "DROP TABLE IF EXISTS _test_import",
  "CREATE TABLE _test_import (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "INSERT INTO _test_import (name) VALUES ('hello'), ('world')",
  "SELECT COUNT(*) as cnt FROM _test_import",
  "DROP TABLE _test_import",
];

foreach ($queries as $i => $q) {
  $result = $wpdb->query($q);
  $err = $wpdb->last_error;
  if ($err) {
    echo "Query $i FAILED: $err\\n  SQL: $q\\n";
  } else {
    echo "Query $i OK (result=$result)\\n";
  }
}
`);
  console.log('\n=== Step 2: MySQL DDL queries ===');
  console.log('Exit:', ddl.exitCode);
  console.log(ddl.stdout);
  if (ddl.stderr) console.log('Stderr:', ddl.stderr);

  // Step 3: Try the exact executeSql code path from playground-sink.ts
  // Write a small SQL file, write the stream class, run it
  const execSql = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

// Write a test SQL file
$sql = "DROP TABLE IF EXISTS _test_import;\\nCREATE TABLE _test_import (id INT PRIMARY KEY, v TEXT);\\nINSERT INTO _test_import VALUES (1, 'test');\\n";
file_put_contents('/tmp/test-import.sql', $sql);

// Now replicate what playground-sink does
require_once '{{DOCROOT}}/wp-load.php';

// Check if WP_MySQL_Naive_Query_Stream exists (it's loaded by WP's SQLite plugin)
echo "WP_MySQL_Naive_Query_Stream: " . (class_exists('WP_MySQL_Naive_Query_Stream') ? 'YES (built-in)' : 'NO (need to inject)') . "\\n";
echo "WP_MySQL_Lexer: " . (class_exists('WP_MySQL_Lexer') ? 'YES' : 'NO') . "\\n";

// If the class doesn't exist, we'd need to require our bundled version
// For now, try using $wpdb directly
global $wpdb;

$handle = fopen('/tmp/test-import.sql', 'r');
$buffer = '';
while (!feof($handle)) {
  $buffer .= fread($handle, 8192);
}
fclose($handle);

// Split on semicolons (naive)
$queries = array_filter(array_map('trim', explode(';', $buffer)));
$success = 0;
$failed = 0;
foreach ($queries as $q) {
  if (empty($q)) continue;
  $result = $wpdb->query($q);
  if ($wpdb->last_error) {
    echo "FAIL: " . $wpdb->last_error . "\\n  SQL: " . substr($q, 0, 100) . "\\n";
    $failed++;
  } else {
    $success++;
  }
}
echo "Results: $success OK, $failed failed\\n";

// Verify
$rows = $wpdb->get_results("SELECT * FROM _test_import");
echo "Rows in _test_import: " . count($rows) . "\\n";
foreach ($rows as $r) echo "  id={$r->id} v={$r->v}\\n";

$wpdb->query("DROP TABLE IF EXISTS _test_import");
`);
  console.log('\n=== Step 3: Full executeSql code path ===');
  console.log('Exit:', execSql.exitCode);
  console.log(execSql.stdout);
  if (execSql.stderr) console.log('Stderr:', execSql.stderr);

  // Step 4: Try with the actual WP_MySQL_Naive_Query_Stream if it exists
  const withStream = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '{{DOCROOT}}/wp-load.php';

if (!class_exists('WP_MySQL_Naive_Query_Stream')) {
  echo "WP_MySQL_Naive_Query_Stream not available, skipping\\n";
  exit(0);
}

$sql = "DROP TABLE IF EXISTS _test_stream;\\nCREATE TABLE _test_stream (id INT PRIMARY KEY, val TEXT);\\nINSERT INTO _test_stream VALUES (1, 'streamed');\\n";
file_put_contents('/tmp/test-stream.sql', $sql);

global $wpdb;
$stream = new WP_MySQL_Naive_Query_Stream();
$handle = fopen('/tmp/test-stream.sql', 'r');

while (!feof($handle)) {
  $chunk = fread($handle, 8192);
  if ($chunk === false) break;
  $stream->append_sql($chunk);
  while ($stream->next_query()) {
    $query = $stream->get_query();
    echo "Executing: " . substr(trim($query), 0, 80) . "\\n";
    $result = $wpdb->query($query);
    if ($wpdb->last_error) {
      echo "  ERROR: " . $wpdb->last_error . "\\n";
    } else {
      echo "  OK (result=$result)\\n";
    }
  }
}
fclose($handle);
$stream->mark_input_complete();
while ($stream->next_query()) {
  $query = $stream->get_query();
  $wpdb->query($query);
}

$rows = $wpdb->get_results("SELECT * FROM _test_stream");
echo "Rows: " . count($rows) . "\\n";
$wpdb->query("DROP TABLE IF EXISTS _test_stream");
echo "Done\\n";
`);
  console.log('\n=== Step 4: WP_MySQL_Naive_Query_Stream ===');
  console.log('Exit:', withStream.exitCode);
  console.log(withStream.stdout);
  if (withStream.stderr) console.log('Stderr:', withStream.stderr);

  expect(simple.exitCode).toBe(0);
});
