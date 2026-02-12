import { test, expect } from '@playwright/test';

/**
 * Step-by-step SQL execution diagnostic to isolate the failure point.
 */
test('step-by-step SQL execution', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-err]', msg.text());
  });

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Step 1: Verify WP_INSTALLING bootstrap works
  const step1 = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docRoot = await pg.documentRoot;
    const result = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('WP_INSTALLING', true);
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);
define('WP_DEBUG', true);
define('WP_DEBUG_DISPLAY', true);
ob_start();
require_once '${docRoot}/wp-load.php';
ob_end_clean();
echo "WP_INSTALLING boot OK\\n";
echo "wpdb class: " . get_class($GLOBALS['wpdb']) . "\\n";
`,
    });
    return { exitCode: result.exitCode, text: (result.text ?? '').substring(0, 500), errors: (result.errors ?? '').substring(0, 500) };
  });

  console.log('\n=== Step 1: WP_INSTALLING bootstrap ===');
  console.log(`Exit: ${step1.exitCode}`);
  console.log(`Output: ${step1.text}`);
  if (step1.errors) console.log(`Errors: ${step1.errors}`);

  // Step 2: Fetch SQL chunk info (without executing)
  const step2 = await page.evaluate(async () => {
    const remoteUrl = (document.getElementById('url') as HTMLInputElement).value;
    const secret = (document.getElementById('secret') as HTMLInputElement).value;
    const enc = new TextEncoder();

    async function authedFetch(endpoint: string, cursor?: string, extraParams?: Record<string, string>) {
      const url = new URL(remoteUrl);
      url.searchParams.set('endpoint', endpoint);
      if (cursor) url.searchParams.set('cursor', btoa(cursor));
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
      }
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

    // sql_preflight
    const t0 = performance.now();
    await authedFetch('sql_preflight');
    const t1 = performance.now();

    // sql_chunk with small fragment count
    const sqlRes = await authedFetch('sql_chunk', undefined, { fragments_per_batch: '10' });
    const t2 = performance.now();

    const contentType = sqlRes.headers.get('content-type') ?? '';
    const rawBytes = new Uint8Array(await sqlRes.arrayBuffer());
    const t3 = performance.now();
    const rawSize = rawBytes.byteLength;

    // Check if response has gzip-encoded parts by looking at headers
    const rawText = new TextDecoder().decode(rawBytes);
    const boundary = contentType.match(/boundary="?([^";\s]+)"?/)?.[1] ?? '';

    // Count parts and check for Content-Encoding headers
    const sections = rawText.split('--' + boundary);
    let sqlPartInfo: { size: number; encoding: string; preview: string }[] = [];
    let completionHeaderDump = '';

    for (const section of sections) {
      if (!section.trim() || section.trim() === '--') continue;
      const sepIdx = section.indexOf('\r\n\r\n');
      if (sepIdx === -1) continue;
      const headerBlock = section.substring(0, sepIdx);
      const body = section.substring(sepIdx + 4);

      if (headerBlock.toLowerCase().includes('x-chunk-type: sql')) {
        const encoding = headerBlock.match(/content-encoding:\s*(\S+)/i)?.[1] ?? 'none';
        sqlPartInfo.push({
          size: body.length,
          encoding,
          preview: body.substring(0, 200),
        });
      } else if (headerBlock.toLowerCase().includes('x-chunk-type: completion')) {
        completionHeaderDump = headerBlock;
      }
    }

    return {
      timing: { preflightMs: Math.round(t1 - t0), fetchMs: Math.round(t2 - t1), readMs: Math.round(t3 - t2) },
      contentType,
      rawSize,
      boundary: boundary.substring(0, 40),
      totalSections: sections.length,
      sqlParts: sqlPartInfo,
      completionHeaders: completionHeaderDump,
    };
  });

  console.log('\n=== Step 2: SQL Chunk Fetch (10 fragments) ===');
  console.log(`Timing: preflight=${step2.timing.preflightMs}ms, fetch=${step2.timing.fetchMs}ms, read=${step2.timing.readMs}ms`);
  console.log(`Content-Type: ${step2.contentType}`);
  console.log(`Raw size: ${step2.rawSize} bytes`);
  console.log(`Boundary: ${step2.boundary}`);
  console.log(`Total sections: ${step2.totalSections}`);
  console.log(`SQL parts: ${step2.sqlParts.length}`);
  for (let i = 0; i < step2.sqlParts.length; i++) {
    const p = step2.sqlParts[i];
    console.log(`  Part ${i}: size=${p.size}, encoding=${p.encoding}`);
    console.log(`  Preview: ${p.preview.substring(0, 150)}`);
  }
  console.log(`Completion headers: ${step2.completionHeaders}`);

  // Step 3: Try executing just a simple CREATE TABLE + INSERT via the same code path as playground-sink
  const step3 = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docRoot = await pg.documentRoot;

    // Write the WP_MySQL_Naive_Query_Stream PHP class
    // (We need to get this from the built library - for now, test with direct wpdb->query)

    // First, drop and recreate a test table
    const result = await pg.run({
      code: `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('WP_INSTALLING', true);
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);
define('WP_DEBUG', true);
define('WP_DEBUG_DISPLAY', true);
ob_start();
require_once '${docRoot}/wp-load.php';
ob_end_clean();

global $wpdb;

// Try the same kind of SQL as a dump would do
$queries = [
  "DROP TABLE IF EXISTS wp_options",
  "CREATE TABLE wp_options (option_id bigint(20) unsigned NOT NULL auto_increment, option_name varchar(191) NOT NULL default '', option_value longtext NOT NULL, autoload varchar(20) NOT NULL default 'yes', PRIMARY KEY (option_id), UNIQUE KEY option_name (option_name), KEY autoload (autoload)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
  "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('siteurl', 'http://localhost', 'yes')",
  "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('blogname', 'Test', 'yes')",
];

$results = [];
foreach ($queries as $q) {
  $r = $wpdb->query($q);
  $err = $wpdb->last_error;
  $results[] = ['query' => substr($q, 0, 80), 'result' => $r, 'error' => $err];
}

echo json_encode($results);
`,
    });
    return { exitCode: result.exitCode, text: (result.text ?? '').substring(0, 2000), errors: (result.errors ?? '').substring(0, 500) };
  });

  console.log('\n=== Step 3: Direct wpdb SQL execution ===');
  console.log(`Exit: ${step3.exitCode}`);
  console.log(`Output: ${step3.text}`);
  if (step3.errors) console.log(`Errors: ${step3.errors}`);

  expect(step1.exitCode).toBe(0);
});
