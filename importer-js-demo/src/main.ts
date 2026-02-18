import { startPlaygroundWeb } from '@wp-playground/client';
import type { PlaygroundClient } from '@wp-playground/client';
import { importSite, PlaygroundImportTarget } from '@streaming-site-migration/importer-js';
import type { ImportProgress } from '@streaming-site-migration/importer-js';

const iframe = document.getElementById('playground') as HTMLIFrameElement;
const btnImport = document.getElementById('btn-import') as HTMLButtonElement;
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement;
const statusBar = document.getElementById('status-bar')!;
const phaseBadge = document.getElementById('phase-badge')!;
const statusMessage = document.getElementById('status-message')!;
const statusCount = document.getElementById('status-count')!;
const elapsedTime = document.getElementById('elapsed-time')!;
const logEl = document.getElementById('log')!;
const urlInput = document.getElementById('url') as HTMLInputElement;
const secretInput = document.getElementById('secret') as HTMLInputElement;
const skipFilesInput = document.getElementById('skip-files') as HTMLInputElement;
const btnAdmin = document.getElementById('btn-admin') as HTMLButtonElement;
const btnFullscreen = document.getElementById('btn-fullscreen') as HTMLButtonElement;
const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement;

let playground: PlaygroundClient;
let abortController: AbortController | null = null;
let elapsedInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function startElapsedTimer() {
  stopElapsedTimer();
  const startTime = Date.now();
  elapsedTime.textContent = '0:00';
  elapsedInterval = setInterval(() => {
    elapsedTime.textContent = formatElapsed(Date.now() - startTime);
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedInterval !== null) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}

function log(msg: string, cls = 'entry') {
  logEl.classList.add('visible');
  const div = document.createElement('div');
  div.className = `entry ${cls}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function showStatus(phase: string, message: string, count = '') {
  statusBar.classList.add('visible');
  phaseBadge.textContent = phase;
  phaseBadge.className = 'phase-badge active';
  statusMessage.textContent = message;
  statusCount.textContent = count;
}

function showDone(phase: string, message: string) {
  stopElapsedTimer();
  phaseBadge.textContent = phase;
  phaseBadge.className = 'phase-badge done';
  statusMessage.textContent = message;
  statusCount.textContent = '';
}

function showError(message: string) {
  stopElapsedTimer();
  phaseBadge.textContent = 'ERROR';
  phaseBadge.className = 'phase-badge error';
  statusMessage.textContent = message;
  statusCount.textContent = '';
}

const phaseLabels: Record<string, string> = {
  preflight: 'Preflight',
  sql_preflight: 'SQL Preflight',
  sql: 'SQL Sync',
  file_index: 'File Index',
  file_fetch: 'File Fetch',
};

let lastLoggedPhase = '';
let lastLoggedFileCount = 0;

function onProgress(p: ImportProgress) {
  const label = phaseLabels[p.phase] ?? p.phase;
  let count = '';

  // Log phase transitions
  if (p.phase !== lastLoggedPhase) {
    lastLoggedPhase = p.phase;
    lastLoggedFileCount = 0;
    log(`${label}...`);
  }

  if (p.phase === 'file_index' && p.filesTotal) {
    count = `${p.filesTotal.toLocaleString()} files indexed`;
    // Log every 1000 files indexed
    if (p.filesTotal >= lastLoggedFileCount + 1000) {
      lastLoggedFileCount = Math.floor(p.filesTotal / 1000) * 1000;
      log(`  ${p.filesTotal.toLocaleString()} files indexed`);
    }
  } else if (p.phase === 'file_fetch' && p.filesTotal) {
    const done = p.filesDone ?? 0;
    count = `${done.toLocaleString()} / ${p.filesTotal.toLocaleString()} files`;
    // Log every 500 files fetched
    if (done >= lastLoggedFileCount + 500) {
      lastLoggedFileCount = Math.floor(done / 500) * 500;
      const pct = Math.round((done / p.filesTotal) * 100);
      log(`  ${done.toLocaleString()} / ${p.filesTotal.toLocaleString()} files (${pct}%)`);
    }
  } else if (p.phase === 'sql' && p.status) {
    if (p.bytesTotal && p.bytesDone) {
      const doneMB = (p.bytesDone / (1024 * 1024)).toFixed(1);
      const totalMB = (p.bytesTotal / (1024 * 1024)).toFixed(1);
      count = `${doneMB} / ~${totalMB} MB`;
    }
    if (p.status === 'complete') {
      log('SQL sync complete', 'success');
    } else if (p.status.startsWith('batch') && p.status !== 'running') {
      log(`  SQL ${p.status}`);
    }
  }

  showStatus(label, p.status ?? 'running', count);
}

async function rewriteSiteUrl() {
  const docroot = await playground.documentRoot;
  const playgroundUrl = new URL(await playground.absoluteUrl);
  const newUrl = playgroundUrl.origin;
  // Update SQLite directly — avoids loading WordPress and plugin fatals
  await playground.run({
    code: `<?php
$dbPath = '${docroot}/wp-content/database/.ht.sqlite';
if (!file_exists($dbPath)) { exit(0); }
$db = new PDO('sqlite:' . $dbPath);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$stmt = $db->prepare("UPDATE wp_options SET option_value = ? WHERE option_name IN ('siteurl', 'home')");
$stmt->execute(['${newUrl}']);
`,
  });
}

async function disconnectJetpack() {
  const docroot = await playground.documentRoot;
  await playground.run({
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
$wpdb->suppress_errors(true);
// Delete Jetpack connection tokens to prevent the Playground clone
// from being mistaken for the source site by Jetpack's servers.
$wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name IN (
  'jetpack_options',
  'jetpack_private_options',
  'jetpack_activated',
  'jetpack_connection_active_plugins',
  'jetpack_sync_settings',
  'jetpack_sync_error_idc',
  'jetpack_id',
  'jetpack_register',
  'jetpack_tos_agreed'
)");
// Also clear user-level Jetpack tokens
$wpdb->query("DELETE FROM {$wpdb->usermeta} WHERE meta_key IN (
  'jetpack_token',
  'jetpack_connect_token'
)");
`,
  });
}

async function installAutoLogin() {
  const docroot = await playground.documentRoot;
  const muPluginsDir = docroot + '/wp-content/mu-plugins';
  try { await playground.mkdir(muPluginsDir); } catch { /* exists */ }
  await playground.writeFile(
    muPluginsDir + '/auto-login.php',
    new TextEncoder().encode(`<?php
// Auto-login as the first admin user in Playground.
// No redirect — just set the cookie so the next request is authenticated.
add_action('init', function() {
    if (is_user_logged_in()) return;
    $admins = get_users(['role' => 'administrator', 'number' => 1, 'orderby' => 'ID']);
    if (empty($admins)) return;
    wp_set_current_user($admins[0]->ID);
    wp_set_auth_cookie($admins[0]->ID, true);
});
`),
  );
}

const OPFS_MOUNT_PATH = '/site-import-wp-content';

async function persistToOpfs() {
  const docroot = await playground.documentRoot;
  const wpContent = docroot + '/wp-content';
  try {
    await playground.mountOpfs({
      mountpoint: wpContent,
      device: { type: 'opfs', path: OPFS_MOUNT_PATH },
      initialSyncDirection: 'memfs-to-opfs',
    });
    localStorage.setItem('site-imported', '1');
    log('Site persisted to browser storage', 'success');
  } catch (e) {
    log(`Persistence unavailable: ${e instanceof Error ? e.message : e}`);
  }
}

async function restoreFromOpfs(): Promise<boolean> {
  const docroot = await playground.documentRoot;
  const wpContent = docroot + '/wp-content';
  try {
    await playground.mountOpfs({
      mountpoint: wpContent,
      device: { type: 'opfs', path: OPFS_MOUNT_PATH },
      initialSyncDirection: 'opfs-to-memfs',
    });
    // Check if the database actually exists (sign of a real import)
    const dbExists = await playground.fileExists(wpContent + '/database/.ht.sqlite');
    if (!dbExists) {
      await playground.unmountOpfs(wpContent);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  log('Booting WordPress Playground...');
  playground = await startPlaygroundWeb({
    iframe,
    remoteUrl: 'https://playground.wordpress.net/remote.html',
  });

  // Try restoring a previously imported site from browser storage
  if (localStorage.getItem('site-imported')) {
    const restored = await restoreFromOpfs();
    if (restored) {
      log('Restoring site from browser storage...');
      await rewriteSiteUrl();
      await installAutoLogin();
      btnAdmin.style.display = '';
      btnFullscreen.style.display = '';
      btnDelete.style.display = '';
      await playground.goTo('/');
      log('Site loaded', 'success');
    } else {
      // OPFS data gone but flag was stale — clean up
      localStorage.removeItem('site-imported');
    }
  }

  log('Playground ready', 'success');
  btnImport.disabled = false;
  btnImport.textContent = 'Import Site';
  btnAdmin.style.display = '';
  btnAdmin.disabled = false;
  // Expose for Playwright tests
  (window as any).__playground = playground;
}

async function runImport() {
  const remoteUrl = urlInput.value.trim();
  const secret = secretInput.value.trim();
  if (!remoteUrl || !secret) {
    log('URL and secret are required', 'error');
    return;
  }

  abortController = new AbortController();
  btnImport.disabled = true;
  btnCancel.style.display = '';
  startElapsedTimer();

  const preflight = await detectServerRoot(remoteUrl, secret);
  if (!preflight) return;

  const target = new PlaygroundImportTarget(
    {
      writeFile: (path: string, data: Uint8Array) => playground.writeFile(path, data),
      mkdir: (path: string) => playground.mkdir(path),
      run: (opts: { code: string }) => playground.run(opts),
      documentRoot: await playground.documentRoot,
    },
    preflight.serverRoot,
  );

  const skipFiles = skipFilesInput.checked;

  try {
    log(`Starting import from ${remoteUrl}${skipFiles ? ' (proxy media from source)' : ''}`);

    const result = await importSite(
      { remoteUrl, secret, skipFiles },
      target,
      onProgress,
      abortController.signal,
    );

    // Rewrite siteurl/home so WordPress serves from Playground's URL
    showStatus('Finalize', 'Rewriting site URL...');
    const playgroundUrl = new URL(await playground.absoluteUrl);
    await target.rewriteSiteUrl(playgroundUrl.origin);

    // Drop Jetpack connection tokens so this clone doesn't impersonate the source
    showStatus('Finalize', 'Disconnecting Jetpack...');
    await disconnectJetpack();
    log('Jetpack connection tokens removed', 'success');

    // Install auto-login mu-plugin so WP Admin is accessible
    await installAutoLogin();

    // When files are skipped, rewrite content URLs to load from source
    if (skipFiles) {
      showStatus('Finalize', 'Rewriting content URLs to source...');
      await target.rewriteContentUrls(result.sourceUrl);
      log(`Media proxied from ${result.sourceUrl}`, 'success');
    }

    // Persist wp-content to OPFS so site survives page reloads
    showStatus('Finalize', 'Persisting to browser storage...');
    await persistToOpfs();

    showDone('DONE', 'Import complete!');
    log('Import complete! Navigating to site...', 'success');
    btnAdmin.style.display = '';
    btnFullscreen.style.display = '';
    btnDelete.style.display = '';

    await playground.goTo('/');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted) {
      showError('Import cancelled');
      log('Import cancelled by user', 'error');
    } else {
      showError(msg);
      log(`Import failed: ${msg}`, 'error');
    }
  } finally {
    btnImport.disabled = false;
    btnCancel.style.display = 'none';
    abortController = null;
  }
}

interface ExportSettings {
  exclude_uploads: boolean;
  active_only: boolean;
  active_plugin_dirs: string[];
  active_theme_dirs: string[];
}

interface PreflightResult {
  serverRoot: string;
  exportSettings: ExportSettings | null;
}

async function detectServerRoot(remoteUrl: string, secret: string): Promise<PreflightResult | null> {
  log('Running preflight to detect server root...');
  try {
    // Inline HMAC computation for preflight (avoids deep import)
    const enc = new TextEncoder();
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

    const url = new URL(remoteUrl);
    url.searchParams.set('endpoint', 'preflight');
    const res = await fetch(url.toString(), {
      headers: {
        'X-Auth-Signature': sig,
        'X-Auth-Nonce': nonce,
        'X-Auth-Timestamp': timestamp,
        'X-Auth-Content-Hash': bodyHash,
      },
    });
    if (!res.ok) {
      throw new Error(`Preflight HTTP ${res.status}`);
    }
    const json = await res.json();
    const root = json.wp_detect?.roots?.[0]?.path;
    if (!root) throw new Error('No WordPress root found');
    log(`Server root: ${root}`, 'success');

    const exportSettings: ExportSettings | null = json.export_settings ?? null;
    if (exportSettings) {
      const flags: string[] = [];
      if (exportSettings.exclude_uploads) flags.push('media excluded');
      if (exportSettings.active_only) {
        const np = exportSettings.active_plugin_dirs.length;
        const nt = exportSettings.active_theme_dirs.length;
        flags.push(`active only (${np} plugin${np !== 1 ? 's' : ''}, ${nt} theme${nt !== 1 ? 's' : ''})`);
      }
      if (flags.length > 0) {
        log(`Source settings: ${flags.join(', ')}`, 'success');
      } else {
        log('Source settings: full export (no filters)');
      }
    }

    return { serverRoot: root, exportSettings };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(`Preflight failed: ${msg}`);
    log(`Preflight failed: ${msg}`, 'error');
    btnImport.disabled = false;
    btnCancel.style.display = 'none';
    return null;
  }
}



btnImport.addEventListener('click', runImport);
btnCancel.addEventListener('click', () => {
  abortController?.abort();
});
btnAdmin.addEventListener('click', async () => {
  await installAutoLogin();
  await playground.goTo('/wp-admin/');
});
btnFullscreen.addEventListener('click', () => {
  iframe.requestFullscreen?.() ?? (iframe as any).webkitRequestFullscreen?.();
});
btnDelete.addEventListener('click', async () => {
  if (!confirm('Delete the local site and clear browser storage?')) return;
  try {
    const docroot = await playground.documentRoot;
    await playground.unmountOpfs(docroot + '/wp-content');
  } catch { /* not mounted */ }
  // Clear all OPFS data
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as any).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
  } catch (e) {
    console.warn('OPFS clear failed:', e);
  }
  localStorage.removeItem('site-imported');
  location.reload();
});

boot();
