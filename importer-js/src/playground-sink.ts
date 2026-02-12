import type { ImportTarget } from './types';
import { WP_MYSQL_NAIVE_QUERY_STREAM_PHP } from './sql-stream-php';

export interface PlaygroundClient {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  run(options: { code: string }): Promise<{ exitCode: number; errors: string }>;
  documentRoot: string;
}

export class PlaygroundImportTarget implements ImportTarget {
  private playground: PlaygroundClient;
  private serverRoot: string;
  private sqlCounter = 0;

  get documentRoot(): string {
    return this.playground.documentRoot;
  }

  constructor(playground: PlaygroundClient, serverRoot: string) {
    this.playground = playground;
    this.serverRoot = serverRoot;
  }

  async writeFile(serverPath: string, data: Uint8Array): Promise<void> {
    const mapped = this.mapPath(serverPath);
    // Protect files critical to Playground's SQLite-based WordPress.
    // The source site's wp-config.php has MySQL credentials that would
    // break the WASM/SQLite environment.
    const relative = mapped.startsWith(this.playground.documentRoot)
      ? mapped.slice(this.playground.documentRoot.length).replace(/^\//, '')
      : '';
    // Skip files that would break Playground's SQLite-based WordPress.
    if (
      relative === 'wp-config.php' ||
      relative === 'wp-content/db.php'
    ) {
      return;
    }
    await this.ensureDir(this.dirname(mapped));
    await this.playground.writeFile(mapped, data);
  }

  async mkdirTree(serverPath: string): Promise<void> {
    await this.ensureDir(this.mapPath(serverPath));
  }

  private async ensureDir(absolutePath: string): Promise<void> {
    const parts = absolutePath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      try {
        await this.playground.mkdir(current);
      } catch {
        // directory may already exist
      }
    }
  }

  async executeSql(sqlContent: Uint8Array): Promise<{ exitCode: number; errors: string }> {
    const sqlFilename = `/tmp/import-${this.sqlCounter++}.sql`;
    const streamClassFilename = '/tmp/WP_MySQL_Naive_Query_Stream.php';

    // Write SQL file
    await this.playground.writeFile(sqlFilename, sqlContent);

    // Write stream class PHP
    await this.playground.writeFile(
      streamClassFilename,
      new TextEncoder().encode(WP_MYSQL_NAIVE_QUERY_STREAM_PHP)
    );

    const docroot = this.playground.documentRoot;

    // Run PHP to stream SQL through WordPress's SQLite translation layer.
    const result = await this.playground.run({
      code: `<?php
error_reporting(E_ALL & ~E_NOTICE & ~E_DEPRECATED);
ini_set('display_errors', '0');

// Override wp_die so WordPress boot never kills the process.
// Between SQL batches, core tables are in a transitional state (dropped
// and recreated) which causes is_blog_installed() → dead_db() → wp_die().
// Playground exposes playground_add_filter() in the auto_prepend_file,
// letting us intercept wp_die before WordPress loads.
function _import_noop_die($msg = '', $title = '', $args = []) {
  // intentionally empty — swallow the die during import
}
function _import_return_noop_die() { return '_import_noop_die'; }
if (function_exists('playground_add_filter')) {
  playground_add_filter('wp_die_handler', '_import_return_noop_die');
}

define('WP_INSTALLING', true);
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);

ob_start();
require_once '${docroot}/wp-load.php';
ob_end_clean();

require_once '${streamClassFilename}';

global $wpdb;
$wpdb->suppress_errors(true);
$wpdb->show_errors(false);

// Register FROM_BASE64 as a native SQLite function so the export's
// FROM_BASE64('...') calls work directly. The PHP-level decode was
// unsafe: decoded values containing null bytes (common in serialized
// PHP data) would truncate the SQL query at SQLite's C API layer.
$__udf_registered = false;
try {
  $__drv = $wpdb->dbh;
  $__ref = new ReflectionObject($__drv);
  $__p = $__ref->getProperty('mysql_on_sqlite_driver');
  $__pdo_like = $__p->getValue($__drv);
  $__pdo = $__pdo_like->get_connection()->get_pdo();
  $__pdo->createFunction('FROM_BASE64', 'base64_decode', 1);
  $__udf_registered = true;
} catch (Throwable $__e) {
  // UDF registration failed — fall back to PHP-level decode below
}

// Fallback: decode FROM_BASE64() in PHP when UDF registration fails.
// This is lossy for values containing null bytes but handles ASCII text.
function decode_from_base64($query) {
  return preg_replace_callback(
    "/\`?FROM_BASE64\`?\\s*\\\\(\\s*'([A-Za-z0-9+\\\\/=]*)'\\s*\\\\)/i",
    function($m) {
      $decoded = base64_decode($m[1]);
      return "'" . str_replace("'", "''", $decoded) . "'";
    },
    $query
  );
}

$query_count = 0;
$error_count = 0;

function run_query($wpdb, $query) {
  global $query_count, $error_count, $__udf_registered;
  // Skip queries targeting SQLite driver internal tables
  if (preg_match('/[\\x60\\s]_wp_sqlite_/i', $query)) {
    return;
  }
  // Strip SQL comments — the SQLite translation layer may not handle
  // comment lines (e.g. "-- Dumping data for table ...") embedded in
  // queries that the stream parser groups with the next statement.
  $query = preg_replace('/^\\s*--[^\\n]*$/m', '', $query);
  $query = trim($query);
  if ($query === '') {
    return;
  }
  // Auto-drop before CREATE TABLE so imports overwrite existing tables
  if (preg_match('/CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\x60]?(\\w+)[\\x60]?/i', $query, $m)) {
    $wpdb->query("DROP TABLE IF EXISTS \\x60" . $m[1] . "\\x60");
  }
  if (!$__udf_registered) {
    $query = decode_from_base64($query);
  }
  $wpdb->query($query);
  $query_count++;
  if ($wpdb->last_error) {
    $error_count++;
  }
}

$stream = new WP_MySQL_Naive_Query_Stream();

$handle = fopen('${sqlFilename}', 'r');
if (!$handle) {
  throw new Exception('Failed to open SQL file');
}

$chunk_size = 8192;
while (!feof($handle)) {
  $chunk = fread($handle, $chunk_size);
  if ($chunk === false) {
    break;
  }

  $stream->append_sql($chunk);

  while ($stream->next_query()) {
    run_query($wpdb, $stream->get_query());
  }
}

fclose($handle);

$stream->mark_input_complete();
while ($stream->next_query()) {
  run_query($wpdb, $stream->get_query());
}
`,
    });

    // Clean up temp files
    await this.playground.run({ code: `<?php @unlink('${sqlFilename}'); @unlink('${streamClassFilename}');` });

    return result;
  }

  /**
   * Rewrite siteurl/home in wp_options so WordPress serves from the
   * Playground's local URL instead of the remote source site URL.
   *
   * Also ensures the SQLite db.php drop-in is present in wp-content/.
   * Playground's SQLite integration stores db.php in a non-standard path;
   * after importing SQL, WordPress needs it at the standard location to boot.
   */
  async rewriteSiteUrl(newUrl: string): Promise<void> {
    const docroot = this.playground.documentRoot;
    await this.playground.run({
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
$new_url = '${newUrl}';
$wpdb->update($wpdb->options, ['option_value' => $new_url], ['option_name' => 'siteurl']);
$wpdb->update($wpdb->options, ['option_value' => $new_url], ['option_name' => 'home']);
`,
    });

    // NOTE: Do NOT create a db.php drop-in here. Playground loads SQLite
    // via an auto_prepend_file preload script (0-sqlite.php) that explicitly
    // skips when wp-content/db.php exists. Creating one breaks the mechanism.
  }

  /**
   * Rewrite content URLs so media/assets load from the source server
   * instead of requiring local file copies. Used when skipFiles is enabled.
   *
   * Updates:
   * - wp_posts.post_content: replaces relative /wp-content/uploads/ references
   *   with absolute source URLs
   * - wp_posts.guid: replaces siteurl with source URL
   * - wp_options upload_url_path: points wp_get_attachment_url() to source
   */
  /**
   * Rewrite content URLs so media/assets load from the source server
   * instead of requiring local file copies. Used when skipFiles is enabled.
   *
   * Updates:
   * - wp_posts.post_content: ensures wp-content asset URLs point to source
   * - wp_options upload_url_path: points wp_get_attachment_url() to source
   */
  async rewriteContentUrls(sourceUrl: string): Promise<void> {
    const docroot = this.playground.documentRoot;
    await this.playground.run({
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

$source = '${sourceUrl}';

// The imported SQL has URLs pointing to the original source site.
// siteurl/home have been rewritten to Playground's URL already.
// But post_content still has the original source URLs for media — which is
// exactly what we want when proxying: images/assets load from source.
//
// However, if there were any relative /wp-content/ references, we need to
// make sure they resolve to the source. And wp_get_attachment_url() needs
// upload_url_path set so dynamically-generated attachment URLs point to source.

// Set upload_url_path so wp_get_attachment_url() returns source server URLs
update_option('upload_url_path', $source . '/wp-content/uploads');

// Also ensure upload_path is set (used by some plugins)
update_option('upload_path', 'wp-content/uploads');
`,
    });
  }

  private mapPath(serverPath: string): string {
    if (serverPath.startsWith(this.serverRoot)) {
      return this.playground.documentRoot + serverPath.slice(this.serverRoot.length);
    }
    return serverPath;
  }

  private dirname(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx <= 0 ? '/' : path.substring(0, idx);
  }
}
