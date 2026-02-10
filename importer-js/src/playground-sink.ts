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

    // Run PHP to stream SQL through WordPress
    const result = await this.playground.run({
      code: `<?php
define('WP_SQLITE_AST_DRIVER', true);
require_once '${docroot}/wp-load.php';

require_once '${streamClassFilename}';

global $wpdb;

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
    $query = $stream->get_query();
    $wpdb->query($query);
  }
}

fclose($handle);

$stream->mark_input_complete();
while ($stream->next_query()) {
  $query = $stream->get_query();
  $wpdb->query($query);
}
`,
    });

    // Clean up temp files
    await this.playground.run({ code: `<?php @unlink('${sqlFilename}'); @unlink('${streamClassFilename}');` });

    return result;
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
