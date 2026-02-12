export type EndpointName = 'preflight' | 'sql_preflight' | 'sql_chunk' | 'file_index' | 'file_fetch';
export type ImportPhase = 'preflight' | 'sql_preflight' | 'sql' | 'file_index' | 'file_fetch' | 'rewrite';

export type ChunkType = 'metadata' | 'index_batch' | 'file' | 'directory' | 'symlink' | 'missing' | 'sql' | 'table_stats' | 'progress' | 'completion' | 'error';

export interface ParsedChunk {
  type: ChunkType;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface CompletionInfo {
  status: 'partial' | 'complete';
  cursor: string | null;
}

export interface ImportProgress {
  phase: 'preflight' | 'sql_preflight' | 'sql' | 'file_index' | 'file_fetch';
  status: string;
  tablesTotal?: number;
  tablesDone?: number;
  filesTotal?: number;
  filesDone?: number;
  bytesTotal?: number;
  bytesDone?: number;
  message?: string;
}

export interface ImportConfig {
  remoteUrl: string;
  secret: string;
  batchSize?: number;         // default 5000
  fragmentsPerBatch?: number; // default 1000
  chunkSize?: number;         // default 5242880 (5MB)
  skipFiles?: boolean;        // skip uploading media (wp-content/uploads); proxy from source instead
}

export interface ImportResult {
  serverRoot: string;
  sourceUrl: string;           // base URL of the source site (derived from remoteUrl)
}

export interface ImportTarget {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdirTree(path: string): Promise<void>;
  executeSql(sql: Uint8Array): Promise<{ exitCode: number; errors: string }>;
  documentRoot: string;
}
