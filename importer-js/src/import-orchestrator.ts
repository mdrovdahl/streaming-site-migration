import type { ImportConfig, ImportTarget, ImportProgress, ImportResult, ParsedChunk, CompletionInfo } from './types';
import { streamEndpoint } from './protocol-client';
import { mapServerPath } from './cursor';

const DEFAULT_BATCH_SIZE = '5000';
const DEFAULT_FRAGMENTS_PER_BATCH = '1000';
const DEFAULT_CHUNK_SIZE = '5242880';
const SQL_EXEC_BATCH_BYTES = 2 * 1024 * 1024; // Execute SQL in ~2MB increments

/**
 * Find the last SQL statement boundary (;\n or ;\r\n) in a buffer.
 * Returns everything up to and including the last complete statement,
 * plus the remainder.  Safe for our export format where string values
 * are base64-encoded (base64 never contains ';').
 */
function splitAtLastStatementBoundary(data: Uint8Array): { batch: Uint8Array; rest: Uint8Array } {
	const SEMICOLON = 0x3B; // ;
	const NEWLINE = 0x0A;   // \n

	for (let i = data.length - 1; i >= 1; i--) {
		if (data[i] === NEWLINE && data[i - 1] === SEMICOLON) {
			return {
				batch: data.subarray(0, i + 1),
				rest: data.subarray(i + 1),
			};
		}
	}
	// No statement boundary found — keep everything as remainder
	return { batch: new Uint8Array(0), rest: data };
}

const INTER_REQUEST_DELAY_MS = 500;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const MAX_CONSECUTIVE_FAILURES = 5;

export async function importSite(
	config: ImportConfig,
	target: ImportTarget,
	onProgress?: (p: ImportProgress) => void,
	signal?: AbortSignal,
): Promise<ImportResult> {
	const serverRoot = await runPreflight(config, signal);
	const sqlPreflight = await runSqlPreflight(config, onProgress, signal);
	await runSqlSync(config, target, sqlPreflight.estimatedBytes, onProgress, signal);
	onProgress?.({ phase: 'sql', status: 'complete' });

	{
		const fileList = await runFileIndex(config, serverRoot, onProgress, signal);

		// Filter out core WordPress directories — Playground already has them.
		// When skipFiles is set, also skip media uploads (themes/plugins still transfer).
		// Note: paths from file_index are base64-encoded by the server.
		const filtered = fileList.filter(f => {
			const decoded = decodeBase64Path(f.path);
			const rel = decoded.startsWith(serverRoot)
				? decoded.slice(serverRoot.length).replace(/^\//, '')
				: decoded;
			if (rel.startsWith('wp-admin/') || rel.startsWith('wp-includes/')) {
				return false;
			}
			if (config.skipFiles && rel.startsWith('wp-content/uploads/')) {
				return false;
			}
			return true;
		});

		await runFileFetch(config, target, serverRoot, filtered, onProgress, signal);
	}

	// Derive the source site's base URL from the export API URL
	const parsed = new URL(config.remoteUrl);
	const sourceUrl = parsed.origin;

	return { serverRoot, sourceUrl };
}

/**
 * Drain an async generator manually, collecting yielded chunks and the return value.
 */
async function drainGenerator(
	gen: AsyncGenerator<ParsedChunk, CompletionInfo | undefined>,
	onChunk?: (chunk: ParsedChunk) => void | Promise<void>,
): Promise<CompletionInfo | undefined> {
	let result = await gen.next();
	while (!result.done) {
		if (onChunk) {
			await onChunk(result.value);
		}
		result = await gen.next();
	}
	return result.value;
}

/**
 * Run a cursor-looped endpoint with retry/backoff.
 * Calls streamEndpoint in a loop, resuming with cursors until complete.
 */
async function cursorLoop(
	config: ImportConfig,
	endpoint: Parameters<typeof streamEndpoint>[1],
	params: Record<string, string> | undefined,
	body: Uint8Array | undefined,
	onChunk: ((chunk: ParsedChunk) => void | Promise<void>) | undefined,
	signal?: AbortSignal,
): Promise<void> {
	let cursor: string | null = null;
	let consecutiveFailures = 0;
	let backoffMs = INITIAL_BACKOFF_MS;

	while (true) {
		signal?.throwIfAborted();

		try {
			const gen = streamEndpoint(config, endpoint, cursor, params, body, signal);
			const completion = await drainGenerator(gen, onChunk);

			// Reset backoff on success
			consecutiveFailures = 0;
			backoffMs = INITIAL_BACKOFF_MS;

			if (!completion || completion.status === 'complete') {
				break;
			}
			cursor = completion.cursor;
			await sleep(INTER_REQUEST_DELAY_MS);
		} catch (err) {
			if (signal?.aborted) {
				throw err;
			}
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				throw new Error(`Aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures: ${err}`);
			}
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		}
	}
}

async function runPreflight(
	config: ImportConfig,
	signal?: AbortSignal,
): Promise<string> {
	let metadata: Record<string, unknown> | undefined;

	const gen = streamEndpoint(config, 'preflight', null, undefined, undefined, signal);
	const returnValue = await drainGenerator(gen, (chunk) => {
		if (chunk.type === 'metadata') {
			metadata = JSON.parse(new TextDecoder().decode(chunk.body));
		}
	});

	// Preflight returns plain JSON (not multipart). streamEndpoint returns
	// JSON responses as the generator's return value rather than yielding chunks.
	if (!metadata && returnValue) {
		const obj = returnValue as unknown as Record<string, unknown>;
		if ('wp_detect' in obj) {
			metadata = obj;
		}
	}

	if (!metadata) {
		throw new Error('Preflight: no metadata received');
	}

	const wpDetect = metadata.wp_detect as { roots?: Array<{ path: string }> } | undefined;
	const roots = wpDetect?.roots;
	if (!roots || roots.length === 0) {
		throw new Error('Preflight: no WordPress roots detected');
	}

	return roots[0].path;
}

async function runSqlPreflight(
	config: ImportConfig,
	onProgress?: (p: ImportProgress) => void,
	signal?: AbortSignal,
): Promise<{ estimatedBytes: number }> {
	onProgress?.({ phase: 'sql_preflight', status: 'running' });
	let estimatedBytes = 0;
	await cursorLoop(config, 'sql_preflight', undefined, undefined,
		(chunk) => {
			if (chunk.type === 'table_stats') {
				const tables = JSON.parse(new TextDecoder().decode(chunk.body)) as Array<{ data_bytes?: number }>;
				for (const t of tables) {
					if (t.data_bytes) estimatedBytes += t.data_bytes;
				}
			}
		},
		signal,
	);
	return { estimatedBytes };
}

async function runSqlSync(
	config: ImportConfig,
	target: ImportTarget,
	estimatedBytes: number,
	onProgress?: (p: ImportProgress) => void,
	signal?: AbortSignal,
): Promise<void> {
	let cursor: string | null = null;
	let consecutiveFailures = 0;
	let backoffMs = INITIAL_BACKOFF_MS;
	const fragmentsPerBatch = String(config.fragmentsPerBatch ?? DEFAULT_FRAGMENTS_PER_BATCH);
	let totalBytesReceived = 0;

	while (true) {
		signal?.throwIfAborted();
		onProgress?.({ phase: 'sql', status: 'running', bytesTotal: estimatedBytes, bytesDone: totalBytesReceived });

		try {
			let sqlBuffer: Uint8Array[] = [];
			let sqlBufferSize = 0;
			let batchesExecuted = 0;

			const gen = streamEndpoint(
				config, 'sql_chunk', cursor,
				{ fragments_per_batch: fragmentsPerBatch },
				undefined, signal,
			);

			const completion = await drainGenerator(gen, async (chunk) => {
				if (chunk.type === 'sql') {
					sqlBuffer.push(chunk.body);
					sqlBufferSize += chunk.body.length;
					totalBytesReceived += chunk.body.length;

					if (sqlBufferSize >= SQL_EXEC_BATCH_BYTES) {
						const combined = concatUint8Arrays(sqlBuffer);
						const { batch, rest } = splitAtLastStatementBoundary(combined);
						if (batch.length > 0) {
							const result = await target.executeSql(batch);
							if (result.exitCode !== 0) {
								throw new Error(`SQL execution failed: ${result.errors}`);
							}
							batchesExecuted++;
							onProgress?.({ phase: 'sql', status: `batch ${batchesExecuted}`, bytesTotal: estimatedBytes, bytesDone: totalBytesReceived });
						}
						sqlBuffer = rest.length > 0 ? [rest] : [];
						sqlBufferSize = rest.length;
					}
				}
			});

			// Execute remaining SQL
			if (sqlBuffer.length > 0) {
				const combined = concatUint8Arrays(sqlBuffer);
				const result = await target.executeSql(combined);
				if (result.exitCode !== 0) {
					throw new Error(`SQL execution failed: ${result.errors}`);
				}
			}

			consecutiveFailures = 0;
			backoffMs = INITIAL_BACKOFF_MS;

			if (!completion || completion.status === 'complete') {
				break;
			}
			cursor = completion.cursor;
			await sleep(INTER_REQUEST_DELAY_MS);
		} catch (err) {
			if (signal?.aborted) throw err;
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				throw new Error(`SQL sync aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures: ${err}`);
			}
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		}
	}
}

async function runFileIndex(
	config: ImportConfig,
	serverRoot: string,
	onProgress?: (p: ImportProgress) => void,
	signal?: AbortSignal,
): Promise<FileIndexEntry[]> {
	const batchSize = String(config.batchSize ?? DEFAULT_BATCH_SIZE);
	const fileList: FileIndexEntry[] = [];

	await cursorLoop(
		config, 'file_index', { batch_size: batchSize, list_dir: serverRoot }, undefined,
		(chunk) => {
			if (chunk.type === 'index_batch') {
				const batch = JSON.parse(new TextDecoder().decode(chunk.body)) as FileIndexEntry[];
				for (const entry of batch) {
					fileList.push(entry);
				}
			}
			onProgress?.({ phase: 'file_index', status: 'running', filesTotal: fileList.length });
		},
		signal,
	);

	return fileList;
}

interface FileIndexEntry {
	path: string;
	size: number;
}

async function runFileFetch(
	config: ImportConfig,
	target: ImportTarget,
	serverRoot: string,
	fileList: FileIndexEntry[],
	onProgress?: (p: ImportProgress) => void,
	signal?: AbortSignal,
): Promise<void> {
	let cursor: string | null = null;
	let consecutiveFailures = 0;
	let backoffMs = INITIAL_BACKOFF_MS;
	const chunkSize = String(config.chunkSize ?? DEFAULT_CHUNK_SIZE);
	// Decode base64-encoded paths from file_index before sending to server
	const fileBody = new TextEncoder().encode(JSON.stringify(fileList.map(f => decodeBase64Path(f.path))));
	let filesDone = 0;
	const completedFiles = new Set<string>();
	const pendingFiles = new Map<string, Uint8Array[]>();

	while (true) {
		signal?.throwIfAborted();
		onProgress?.({ phase: 'file_fetch', status: 'running', filesTotal: fileList.length, filesDone });

		try {
			const gen = streamEndpoint(
				config, 'file_fetch', cursor,
				{ chunk_size: chunkSize },
				fileBody, signal,
			);

			const completion = await drainGenerator(gen, async (chunk) => {
				if (chunk.type === 'file') {
					const completedPath = await handleFileChunk(chunk, target, serverRoot, pendingFiles);
					if (completedPath && !completedFiles.has(completedPath)) {
						completedFiles.add(completedPath);
						filesDone++;
					}
				} else if (chunk.type === 'directory') {
					const dirPath = decodeBase64Path(chunk.headers['x-directory-path'] ?? chunk.headers['x-file-path'] ?? '');
					const localPath = mapServerPath(dirPath, serverRoot, target.documentRoot);
					await target.mkdirTree(localPath);
				}
				// symlink: skip per spec
			});

			consecutiveFailures = 0;
			backoffMs = INITIAL_BACKOFF_MS;

			if (!completion || completion.status === 'complete') {
				break;
			}
			cursor = completion.cursor;
			await sleep(INTER_REQUEST_DELAY_MS);
		} catch (err) {
			if (signal?.aborted) throw err;
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				throw new Error(`File fetch aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures: ${err}`);
			}
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		}
	}
}

async function handleFileChunk(
	chunk: ParsedChunk,
	target: ImportTarget,
	serverRoot: string,
	pendingFiles: Map<string, Uint8Array[]>,
): Promise<string | null> {
	const filePath = decodeBase64Path(chunk.headers['x-file-path'] ?? '');
	const chunkIndex = parseInt(chunk.headers['x-chunk-index'] ?? '0', 10);
	const totalChunks = parseInt(chunk.headers['x-total-chunks'] ?? '1', 10);

	if (totalChunks === 1) {
		const localPath = mapServerPath(filePath, serverRoot, target.documentRoot);
		await target.writeFile(localPath, chunk.body);
		return filePath;
	}

	if (!pendingFiles.has(filePath)) {
		pendingFiles.set(filePath, []);
	}
	const chunks = pendingFiles.get(filePath)!;
	chunks[chunkIndex] = chunk.body;

	if (chunks.filter(Boolean).length === totalChunks) {
		const combined = concatUint8Arrays(chunks);
		const localPath = mapServerPath(filePath, serverRoot, target.documentRoot);
		await target.writeFile(localPath, combined);
		pendingFiles.delete(filePath);
		return filePath;
	}

	return null;
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeBase64Path(encoded: string): string {
	try {
		return new TextDecoder().decode(
			Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
		);
	} catch {
		return encoded; // Already decoded or not base64
	}
}

export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	let totalLength = 0;
	for (const arr of arrays) {
		totalLength += arr.length;
	}
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
