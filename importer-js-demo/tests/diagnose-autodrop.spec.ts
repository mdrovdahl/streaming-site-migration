import { test, expect } from '@playwright/test';

/**
 * Test the regex from playground-sink.ts in the actual Playground PHP context.
 */
test('regex escaping in Playground PHP', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);

  await page.goto('/');
  const btnImport = page.locator('#btn-import');
  await expect(btnImport).toHaveText('Import Site', { timeout: 120_000 });

  const result = await page.evaluate(async () => {
    const pg = (window as any).__playground;

    // Test the EXACT PHP code from playground-sink.ts run_query function
    // by injecting it via playground.run() and checking regex behavior
    const r = await pg.run({
      code: `<?php
// Test with a real MySQL CREATE TABLE (plain backticks, no escaping)
$query = 'CREATE TABLE ` + '`' + `wp_commentmeta` + '`' + ` (meta_id bigint(20) unsigned NOT NULL AUTO_INCREMENT)';
echo "Query: " . substr($query, 0, 80) . "\\n";

// Test 1: The exact regex from playground-sink.ts compiled JS
// In the dist file: '/CREATE\\\\s+TABLE\\\\s+(?:IF\\\\s+NOT\\\\s+EXISTS\\\\s+)?[\\\\x60]?(\\\\w+)[\\\\x60]?/i'
// After JS template processing, PHP receives: '/CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\x60]?(\\w+)[\\x60]?/i'
$p1 = '/CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\x60]?(\\w+)[\\x60]?/i';
echo "P1 (single-quoted hex): ";
if (preg_match($p1, $query, $m)) {
  echo "MATCH: " . $m[1] . "\\n";
} else {
  echo "NO MATCH (error=" . preg_last_error() . ")\\n";
}

// Test 2: With literal backtick in the pattern
$p2 = '/CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?` + '`' + `?(\\w+)` + '`' + `?/i';
echo "P2 (literal backtick): ";
if (preg_match($p2, $query, $m2)) {
  echo "MATCH: " . $m2[1] . "\\n";
} else {
  echo "NO MATCH\\n";
}

// Test 3: Without backtick handling at all
$p3 = '/CREATE\\s+TABLE\\s+(\\w+)/i';
echo "P3 (no backtick): ";
if (preg_match($p3, $query, $m3)) {
  echo "MATCH: " . $m3[1] . "\\n";
} else {
  echo "NO MATCH\\n";
}

// Test 4: Hex dump of what PHP sees for the pattern
echo "P1 hex at bracket pos: ";
$idx = strpos($p1, '[');
if ($idx !== false) {
  for ($i = $idx; $i < $idx + 10 && $i < strlen($p1); $i++) {
    echo sprintf("%02x ", ord($p1[$i]));
  }
}
echo "\\n";

// Test 5: Check what the query looks like (hex of backtick area)
echo "Query hex around CREATE TABLE: ";
$ct_pos = strpos($query, 'CREATE TABLE');
if ($ct_pos !== false) {
  $start = $ct_pos + strlen('CREATE TABLE ');
  for ($i = $start; $i < $start + 20 && $i < strlen($query); $i++) {
    echo sprintf("%02x ", ord($query[$i]));
  }
}
echo "\\n";
echo "Backtick char hex: " . sprintf("%02x", ord('` + '`' + `')) . "\\n";

// Test 6: Using double-quoted string for pattern (PHP interprets \\x60)
$p6 = "/CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\x60]?(\\w+)[\\x60]?/i";
echo "P6 (double-quoted hex): ";
if (preg_match($p6, $query, $m6)) {
  echo "MATCH: " . $m6[1] . "\\n";
} else {
  echo "NO MATCH\\n";
}
`,
    });

    return { exit: r.exitCode, text: (r.text ?? '').substring(0, 3000), err: (r.errors ?? '').substring(0, 1000) };
  });

  console.log(`Exit: ${result.exit}`);
  console.log(result.text);
  if (result.err) console.log(`Errors: ${result.err}`);

  expect(result.exit).toBe(0);
});
