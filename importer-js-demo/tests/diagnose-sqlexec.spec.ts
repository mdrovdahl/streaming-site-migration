import { test, expect } from '@playwright/test';
import { startPlaygroundWeb } from '@wp-playground/client';
import { importSite, PlaygroundImportTarget } from '@streaming-site-migration/importer-js';

test('instrumented SQL execution', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  // Instead of clicking import, we'll drive it programmatically
  // to intercept executeSql
  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;
    const docroot = await pg.documentRoot;

    // Fetch a small SQL chunk from the export API
    const remoteUrl = (document.getElementById('url') as HTMLInputElement).value;
    const secret = (document.getElementById('secret') as HTMLInputElement).value;
    const enc = new TextEncoder();

    async function authedFetch(endpoint: string, cursor?: string, extraParams?: Record<string, string>) {
      const url = new URL(remoteUrl);
      url.searchParams.set('endpoint', endpoint);
      if (cursor) url.searchParams.set('cursor', cursor);
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
      }
      const bodyStr = '';
      const bodyHash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(bodyStr))),
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

    // Preflight
    await authedFetch('sql_preflight');

    // Fetch SQL with small fragment count to see structure
    const sqlRes = await authedFetch('sql_chunk', undefined, { fragments_per_batch: '50' });
    const rawBytes = new Uint8Array(await sqlRes.arrayBuffer());
    const rawText = new TextDecoder().decode(rawBytes);

    // Look for siteurl in the raw response
    const hasSiteurl = rawText.includes('siteurl') || rawText.includes('c2l0ZXVybA'); // base64 of 'siteurl'
    const hasCreateOptions = rawText.includes('wp_options');
    
    // Count FROM_BASE64 occurrences
    const fb64Count = (rawText.match(/FROM_BASE64/g) || []).length;

    // Extract first 2000 chars of SQL content (skip multipart headers)
    const contentType = sqlRes.headers.get('content-type') ?? '';
    const boundary = contentType.match(/boundary="?([^";\s]+)"?/)?.[1] ?? '';
    
    let sqlPreview = '';
    const sections = rawText.split('--' + boundary);
    for (const section of sections) {
      if (!section.trim() || section.trim() === '--') continue;
      const sepIdx = section.indexOf('\r\n\r\n');
      if (sepIdx === -1) continue;
      const headers = section.substring(0, sepIdx).toLowerCase();
      const body = section.substring(sepIdx + 4);
      if (headers.includes('x-chunk-type: sql')) {
        sqlPreview += body.substring(0, 1500) + '\n---\n';
      }
    }

    return {
      contentType,
      rawSize: rawBytes.byteLength,
      hasSiteurl,
      hasCreateOptions,
      fb64Count,
      sqlPreview: sqlPreview.substring(0, 3000),
    };
  });

  console.log(`Raw size: ${result.rawSize}`);
  console.log(`Has siteurl: ${result.hasSiteurl}`);
  console.log(`Has wp_options: ${result.hasCreateOptions}`);
  console.log(`FROM_BASE64 count: ${result.fb64Count}`);
  console.log(`\n--- SQL Preview ---`);
  console.log(result.sqlPreview);
});
