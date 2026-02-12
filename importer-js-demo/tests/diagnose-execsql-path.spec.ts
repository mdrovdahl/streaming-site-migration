import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Test the exact executeSql code path from playground-sink.ts:
 * 1. Write SQL to /tmp
 * 2. Write WP_MySQL_Naive_Query_Stream.php to /tmp
 * 3. Run the PHP that loads WP, requires the stream class, executes SQL
 */
test('exact executeSql code path', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser]', msg.text());
  });

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Read the compiled JS to extract the PHP string
  const distFile = readFileSync(
    resolve(__dirname, '../../importer-js/dist/sql-stream-php.js'),
    'utf-8',
  );
  // Extract the template literal content (between first ` and last `)
  const match = distFile.match(/`([\s\S]*)`/);
  const phpSource = match![1];

  const result = await page.evaluate(async (streamPhp) => {
    const pg = (window as any).__playground;
    const docRoot = await pg.documentRoot;
    const WP_MYSQL_NAIVE_QUERY_STREAM_PHP = streamPhp;

    // Write a test SQL file (typical mysqldump header + simple table)
    const testSql = [
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
      "SET time_zone = '+00:00';",
      "SET NAMES utf8mb4;",
      '',
      'DROP TABLE IF EXISTS `_diag_test`;',
      'CREATE TABLE `_diag_test` (',
      '  `id` int(11) NOT NULL AUTO_INCREMENT,',
      '  `title` varchar(255) NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
      '',
      "INSERT INTO `_diag_test` (`id`, `title`) VALUES (1, 'Hello'), (2, 'World');",
      '',
    ].join('\n');

    const sqlFilename = '/tmp/diag-import.sql';
    const streamClassFilename = '/tmp/WP_MySQL_Naive_Query_Stream.php';

    // Write files exactly like playground-sink.ts does
    await pg.writeFile(sqlFilename, new TextEncoder().encode(testSql));
    await pg.writeFile(streamClassFilename, new TextEncoder().encode(WP_MYSQL_NAIVE_QUERY_STREAM_PHP));

    // Verify the PHP file was written correctly
    const phpContent = await pg.readFileAsText(streamClassFilename);
    const firstLines = phpContent.split('\n').slice(0, 5).join('\n');
    const hasDollarSign = phpContent.includes('private $sql_buffer');
    const hasBackslashDollar = phpContent.includes('private \\$sql_buffer');

    // Run the exact same PHP code as playground-sink.ts executeSql()
    const phpResult = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

define('WP_SQLITE_AST_DRIVER', true);
require_once '${docRoot}/wp-load.php';

require_once '${streamClassFilename}';

global $wpdb;

$stream = new WP_MySQL_Naive_Query_Stream();

$handle = fopen('${sqlFilename}', 'r');
if (!$handle) {
  throw new Exception('Failed to open SQL file');
}

$chunk_size = 8192;
$query_count = 0;
$errors = [];

while (!feof($handle)) {
  $chunk = fread($handle, $chunk_size);
  if ($chunk === false) break;

  $stream->append_sql($chunk);

  while ($stream->next_query()) {
    $query = $stream->get_query();
    $query_count++;
    $result = $wpdb->query($query);
    if ($wpdb->last_error) {
      $errors[] = "Query $query_count: " . $wpdb->last_error . " | SQL: " . substr(trim($query), 0, 80);
    }
  }
}

fclose($handle);

$stream->mark_input_complete();
while ($stream->next_query()) {
  $query = $stream->get_query();
  $query_count++;
  $wpdb->query($query);
  if ($wpdb->last_error) {
    $errors[] = "Query $query_count: " . $wpdb->last_error;
  }
}

echo "Queries executed: $query_count\\n";
if (count($errors) > 0) {
  echo "Errors:\\n";
  foreach ($errors as $e) echo "  $e\\n";
} else {
  echo "No errors\\n";
}

// Verify data
$rows = $wpdb->get_results("SELECT * FROM _diag_test");
echo "Rows: " . count($rows) . "\\n";
foreach ($rows as $r) {
  echo "  id={$r->id} title={$r->title}\\n";
}

// Cleanup
$wpdb->query("DROP TABLE IF EXISTS _diag_test");
`,
    });

    return {
      firstLines,
      hasDollarSign,
      hasBackslashDollar,
      exitCode: phpResult.exitCode,
      stdout: phpResult.text ?? '',
      stderr: phpResult.errors ?? '',
    };
  }, phpSource);

  console.log('\n=== PHP File Content Check ===');
  console.log('First lines:', result.firstLines);
  console.log('Has correct $: ', result.hasDollarSign);
  console.log('Has wrong \\$:', result.hasBackslashDollar);

  console.log('\n=== executeSql Result ===');
  console.log('Exit:', result.exitCode);
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('No errors');
  expect(result.stdout).toContain('Rows: 2');
});
