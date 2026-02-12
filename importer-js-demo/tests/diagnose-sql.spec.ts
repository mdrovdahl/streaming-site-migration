import { test, expect } from '@playwright/test';

/**
 * Diagnostic test: isolate why PHP.run() with wp-load.php fails inside Playground.
 */
test('diagnose wp-load.php inside Playground', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser]', msg.text());
  });

  await page.goto('/');

  // Wait for Playground to boot
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Helper to run PHP inside the already-booted Playground
  async function runPhp(code: string) {
    return page.evaluate(async (phpCode) => {
      const pg = (window as any).__playground;
      const docRoot = await pg.documentRoot;
      // Replace {{DOCROOT}} placeholder
      const finalCode = phpCode.replace(/\{\{DOCROOT\}\}/g, docRoot);
      const result = await pg.run({ code: finalCode });
      return {
        exitCode: result.exitCode,
        stdout: result.text ?? '',
        stderr: result.errors ?? '',
      };
    }, code);
  }

  // Step 1: Basic PHP
  const basic = await runPhp(`<?php echo "PHP works. Version: " . phpversion();`);
  console.log('\n=== Step 1: Basic PHP ===');
  console.log('Exit:', basic.exitCode, '| Out:', basic.stdout);

  // Step 2: File checks
  const files = await runPhp(`<?php
$dr = '{{DOCROOT}}';
echo "docroot: $dr\\n";
echo "wp-load.php: " . (file_exists("$dr/wp-load.php") ? 'YES' : 'NO') . "\\n";
echo "wp-config.php: " . (file_exists("$dr/wp-config.php") ? 'YES' : 'NO') . "\\n";
echo "db.php: " . (file_exists("$dr/wp-content/db.php") ? 'YES' : 'NO') . "\\n";

// Find SQLite-related files
$paths = glob("$dr/wp-content/{plugins,mu-plugins}/*sqlite*", GLOB_BRACE);
foreach ($paths as $p) echo "sqlite: $p\\n";
$paths = glob("$dr/wp-content/{plugins,mu-plugins}/*sqlite*/*", GLOB_BRACE);
foreach ($paths as $p) echo "  -> " . basename($p) . "\\n";

echo "WP_SQLITE_AST_DRIVER already defined: " . (defined('WP_SQLITE_AST_DRIVER') ? 'YES' : 'NO') . "\\n";
`);
  console.log('\n=== Step 2: File Checks ===');
  console.log('Exit:', files.exitCode);
  console.log(files.stdout);
  if (files.stderr) console.log('Stderr:', files.stderr);

  // Step 3: Load wp-load.php with error reporting
  const wpLoad = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

ob_start();
try {
  require_once '{{DOCROOT}}/wp-load.php';
  $buffered = ob_get_clean();
  echo "SUCCESS: wp-load.php loaded\\n";
  echo "wpdb class: " . get_class($GLOBALS['wpdb']) . "\\n";
  echo "Buffered: " . strlen($buffered) . " bytes\\n";
  if (strlen($buffered) > 0) echo "First 200 chars: " . substr($buffered, 0, 200) . "\\n";
} catch (Throwable $e) {
  $buffered = ob_get_clean();
  echo "CAUGHT: " . get_class($e) . ": " . $e->getMessage() . "\\n";
  echo "At: " . $e->getFile() . ":" . $e->getLine() . "\\n";
  echo "Trace: " . $e->getTraceAsString() . "\\n";
  if ($buffered) echo "Buffered: " . substr($buffered, 0, 500) . "\\n";
}
`);
  console.log('\n=== Step 3: wp-load.php (no WP_SQLITE_AST_DRIVER define) ===');
  console.log('Exit:', wpLoad.exitCode);
  console.log(wpLoad.stdout.substring(0, 2000));
  if (wpLoad.stderr) console.log('Stderr:', wpLoad.stderr.substring(0, 2000));

  // Step 4: Load with WP_SQLITE_AST_DRIVER
  const wpLoadAst = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

ob_start();
try {
  if (!defined('WP_SQLITE_AST_DRIVER')) define('WP_SQLITE_AST_DRIVER', true);
  require_once '{{DOCROOT}}/wp-load.php';
  $buffered = ob_get_clean();
  echo "SUCCESS with AST driver\\n";
  echo "wpdb class: " . get_class($GLOBALS['wpdb']) . "\\n";
} catch (Throwable $e) {
  $buffered = ob_get_clean();
  echo "CAUGHT: " . get_class($e) . ": " . $e->getMessage() . "\\n";
  echo "At: " . $e->getFile() . ":" . $e->getLine() . "\\n";
  if ($buffered) echo "Buffered: " . substr($buffered, 0, 500) . "\\n";
}
`);
  console.log('\n=== Step 4: wp-load.php WITH WP_SQLITE_AST_DRIVER ===');
  console.log('Exit:', wpLoadAst.exitCode);
  console.log(wpLoadAst.stdout.substring(0, 2000));
  if (wpLoadAst.stderr) console.log('Stderr:', wpLoadAst.stderr.substring(0, 2000));

  // Step 5: Check for WP_MySQL_Lexer after loading WP
  const lexer = await runPhp(`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();
require_once '{{DOCROOT}}/wp-load.php';
ob_end_clean();

echo "WP_MySQL_Lexer: " . (class_exists('WP_MySQL_Lexer') ? 'YES' : 'NO') . "\\n";

// Search for lexer files
$search_dirs = [
  '{{DOCROOT}}/wp-content',
  '{{DOCROOT}}/wp-includes',
];
foreach ($search_dirs as $dir) {
  if (!is_dir($dir)) continue;
  $iter = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
    RecursiveIteratorIterator::SELF_FIRST
  );
  foreach ($iter as $file) {
    $name = $file->getFilename();
    if (stripos($name, 'lexer') !== false || stripos($name, 'query-stream') !== false || stripos($name, 'QueryStream') !== false) {
      echo "Found: " . str_replace('{{DOCROOT}}', '', $file->getPathname()) . "\\n";
    }
  }
}
`);
  console.log('\n=== Step 5: WP_MySQL_Lexer Check ===');
  console.log('Exit:', lexer.exitCode);
  console.log(lexer.stdout.substring(0, 3000));
  if (lexer.stderr) console.log('Stderr:', lexer.stderr.substring(0, 1000));

  // Basic PHP must work for the test to be meaningful
  expect(basic.exitCode).toBe(0);
});
