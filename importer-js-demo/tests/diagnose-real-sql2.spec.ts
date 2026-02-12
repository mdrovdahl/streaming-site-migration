import { test, expect } from '@playwright/test';

/**
 * Run the actual import but capture detailed PHP errors via shutdown handler + file.
 */
test('capture real SQL execution errors', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-err]', msg.text());
  });

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Step 1: Drop all WP tables (simulating what SQL dump does) and try loading WP
  // with a shutdown function that writes the error to a file
  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docRoot = await pg.documentRoot;

    // First, drop all tables
    const drop = await pg.run({
      code: `<?php
require_once '${docRoot}/wp-load.php';
global $wpdb;
$tables = $wpdb->get_results("SELECT name FROM sqlite_master WHERE type='table'", ARRAY_A);
foreach ($tables as $t) {
  $name = $t['name'];
  if ($name === 'sqlite_sequence') continue;
  $wpdb->query("DROP TABLE IF EXISTS \`$name\`");
}
echo "Dropped " . count($tables) . " tables\\n";
$remaining = $wpdb->get_var("SELECT COUNT(*) FROM sqlite_master WHERE type='table'");
echo "Remaining: $remaining\\n";
`,
    });

    // Now try loading WP after all tables are gone
    const load = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

// Write errors to a file so we can read them even if PHP exits
register_shutdown_function(function() {
  $error = error_get_last();
  $log = "=== SHUTDOWN ===\\n";
  $log .= "error_get_last: " . print_r($error, true) . "\\n";
  $log .= "output buffer: " . (ob_get_level() > 0 ? ob_get_clean() : '(no buffer)') . "\\n";
  file_put_contents('/tmp/wp-load-debug.log', $log);
});

define('WP_DISABLE_FATAL_ERROR_HANDLER', true);
define('WP_DEBUG', true);
define('WP_DEBUG_DISPLAY', true);

ob_start();
require_once '${docRoot}/wp-load.php';
$output = ob_get_clean();

file_put_contents('/tmp/wp-load-debug.log', "=== SUCCESS ===\\nOutput len: " . strlen($output) . "\\nFirst 500: " . substr($output, 0, 500));
echo "Loaded OK\\n";
`,
    });

    // Read the debug log
    let debugLog = '';
    try {
      debugLog = await pg.readFileAsText('/tmp/wp-load-debug.log');
    } catch {
      debugLog = '(file not found)';
    }

    // Also read the PHP error log if it exists
    let phpErrorLog = '';
    try {
      phpErrorLog = await pg.readFileAsText('/tmp/php-errors.log');
    } catch {
      try {
        // Try WordPress's debug.log
        phpErrorLog = await pg.readFileAsText(`${docRoot}/wp-content/debug.log`);
      } catch {
        phpErrorLog = '(no error log found)';
      }
    }

    return {
      drop: { exitCode: drop.exitCode, stdout: drop.text ?? '', stderr: drop.errors ?? '' },
      load: { exitCode: load.exitCode, stdout: load.text ?? '', stderr: load.errors ?? '' },
      debugLog,
      phpErrorLog: phpErrorLog.substring(0, 3000),
    };
  });

  console.log('\n=== DROP tables ===');
  console.log('Exit:', result.drop.exitCode);
  console.log(result.drop.stdout);
  if (result.drop.stderr) console.log('Stderr:', result.drop.stderr);

  console.log('\n=== WP Load after DROP ===');
  console.log('Exit:', result.load.exitCode);
  console.log('Stdout:', result.load.stdout.substring(0, 2000));
  if (result.load.stderr) console.log('Stderr:', result.load.stderr.substring(0, 2000));

  console.log('\n=== Debug Log ===');
  console.log(result.debugLog.substring(0, 3000));

  console.log('\n=== PHP Error Log ===');
  console.log(result.phpErrorLog);

  expect(result.drop.exitCode).toBe(0);
});
