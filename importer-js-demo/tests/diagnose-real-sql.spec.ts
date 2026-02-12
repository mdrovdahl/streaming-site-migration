import { test, expect } from '@playwright/test';

/**
 * Fetch one real SQL batch from the server and try to execute it in Playground.
 * This isolates the exact PHP error without retry/backoff delays.
 */
test('execute real SQL batch in Playground', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-err]', msg.text());
  });

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docRoot = await pg.documentRoot;

    // Get config from the page inputs
    const remoteUrl = (document.getElementById('url') as HTMLInputElement).value;
    const secret = (document.getElementById('secret') as HTMLInputElement).value;

    // Step 1: Run sql_preflight to set up, then fetch first sql_chunk
    // We'll manually do the HMAC + fetch to get raw SQL data
    const enc = new TextEncoder();

    async function authedFetch(endpoint: string, cursor?: string) {
      const url = new URL(remoteUrl);
      url.searchParams.set('endpoint', endpoint);
      if (cursor) url.searchParams.set('cursor', btoa(cursor));

      const bodyHash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(''))),
      ).map(b => b.toString(16).padStart(2, '0')).join('');

      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const timestamp = (Date.now() / 1000).toFixed(6);

      const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const sig = Array.from(
        new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(nonce + timestamp + bodyHash))),
      ).map(b => b.toString(16).padStart(2, '0')).join('');

      return fetch(url.toString(), {
        headers: {
          'X-Auth-Signature': sig,
          'X-Auth-Nonce': nonce,
          'X-Auth-Timestamp': timestamp,
          'X-Auth-Content-Hash': bodyHash,
        },
      });
    }

    // Fetch first SQL chunk as raw text (not multipart parsed)
    const sqlRes = await authedFetch('sql_chunk');
    const sqlContentType = sqlRes.headers.get('content-type') ?? '';
    const sqlRawBytes = await sqlRes.arrayBuffer();
    const sqlRawSize = sqlRawBytes.byteLength;

    // If it's JSON, it might be an error
    if (sqlContentType.startsWith('application/json')) {
      const text = new TextDecoder().decode(sqlRawBytes);
      return { step: 'fetch', error: `Got JSON instead of multipart: ${text.substring(0, 500)}` };
    }

    // For multipart/gzip, we can't easily parse it in this context.
    // Instead, let's use the library's streamEndpoint to get the SQL chunks.
    // Actually, let's just try running a simple wp-load.php with the debug flags
    // and see if the error message is different now.

    // Step 2: Try loading WordPress with our debug flags
    const wpLoadResult = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);
define('WP_DEBUG', true);
define('WP_DEBUG_DISPLAY', true);

ob_start();
require_once '${docRoot}/wp-load.php';
$output = ob_get_clean();
echo "WP loaded OK. Output: " . strlen($output) . " bytes\\n";
if (strlen($output) > 0) {
  echo "WP output: " . substr($output, 0, 500) . "\\n";
}
echo "wpdb class: " . get_class($GLOBALS['wpdb']) . "\\n";

// Now try a DROP TABLE like a real dump would do
global $wpdb;
$test_queries = [
  "DROP TABLE IF EXISTS wp_commentmeta",
  "DROP TABLE IF EXISTS wp_comments",
  "DROP TABLE IF EXISTS wp_links",
  "DROP TABLE IF EXISTS wp_options",
  "DROP TABLE IF EXISTS wp_postmeta",
  "DROP TABLE IF EXISTS wp_posts",
  "DROP TABLE IF EXISTS wp_term_relationships",
  "DROP TABLE IF EXISTS wp_term_taxonomy",
  "DROP TABLE IF EXISTS wp_termmeta",
  "DROP TABLE IF EXISTS wp_terms",
  "DROP TABLE IF EXISTS wp_usermeta",
  "DROP TABLE IF EXISTS wp_users",
];
foreach ($test_queries as $q) {
  $result = $wpdb->query($q);
  $err = $wpdb->last_error;
  echo "$q => result=$result" . ($err ? " ERROR: $err" : " OK") . "\\n";
}
`,
    });

    // Step 3: Now try loading WordPress AGAIN (after tables are dropped)
    const wpLoad2 = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);
define('WP_DEBUG', true);
define('WP_DEBUG_DISPLAY', true);

ob_start();
try {
  require_once '${docRoot}/wp-load.php';
  $output = ob_get_clean();
  echo "WP loaded OK after DROP. Output: " . strlen($output) . " bytes\\n";
  if (strlen($output) > 0) {
    echo "Content: " . substr($output, 0, 1000) . "\\n";
  }
} catch (Throwable $e) {
  $output = ob_get_clean();
  echo "EXCEPTION: " . $e->getMessage() . "\\n";
  echo "At: " . $e->getFile() . ":" . $e->getLine() . "\\n";
  echo "Output: " . substr($output, 0, 1000) . "\\n";
}
`,
    });

    return {
      step: 'all',
      sqlContentType,
      sqlRawSize,
      wpLoad: {
        exitCode: wpLoadResult.exitCode,
        stdout: wpLoadResult.text ?? '',
        stderr: wpLoadResult.errors ?? '',
      },
      wpLoad2: {
        exitCode: wpLoad2.exitCode,
        stdout: wpLoad2.text ?? '',
        stderr: wpLoad2.errors ?? '',
      },
    };
  });

  if ('error' in result) {
    console.log('Error:', result.error);
  } else {
    console.log('\n=== SQL Fetch ===');
    console.log('Content-Type:', result.sqlContentType);
    console.log('Raw size:', result.sqlRawSize, 'bytes');

    console.log('\n=== WP Load + DROP tables ===');
    console.log('Exit:', result.wpLoad.exitCode);
    console.log(result.wpLoad.stdout.substring(0, 3000));
    if (result.wpLoad.stderr) console.log('Stderr:', result.wpLoad.stderr.substring(0, 1000));

    console.log('\n=== WP Load AFTER DROP tables ===');
    console.log('Exit:', result.wpLoad2.exitCode);
    console.log(result.wpLoad2.stdout.substring(0, 3000));
    if (result.wpLoad2.stderr) console.log('Stderr:', result.wpLoad2.stderr.substring(0, 2000));
  }

  expect(result.step).toBe('all');
});
