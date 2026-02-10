import type { ImportConfig, EndpointName, ParsedChunk, CompletionInfo, ChunkType } from './types';
import { HmacClient } from './hmac';
import { encodeCursor } from './cursor';
import { MultipartStreamParser, extractBoundary } from './multipart-parser';

export async function* streamEndpoint(
	config: ImportConfig,
	endpoint: EndpointName,
	cursor: string | null,
	params?: Record<string, string>,
	body?: Uint8Array,
	signal?: AbortSignal,
): AsyncGenerator<ParsedChunk, CompletionInfo | undefined> {
	const url = new URL(config.remoteUrl);
	url.searchParams.set('endpoint', endpoint);
	if (cursor !== null) {
		url.searchParams.set('cursor', encodeCursor(cursor));
	}
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
	}

	const hmac = new HmacClient(config.secret);
	const method = body ? 'POST' : 'GET';

	let fetchBody: FormData | undefined;
	let hmacBody = '';

	if (body) {
		const formData = new FormData();
		formData.append(
			'file_list',
			new Blob([body as BlobPart], { type: 'application/json' }),
			'file_list.json',
		);
		fetchBody = formData;
		hmacBody = new TextDecoder().decode(body);
	}

	const authHeaders = await hmac.getAuthHeaders(hmacBody);
	const headers: Record<string, string> = {
		...authHeaders,
		'Accept-Encoding': 'gzip',
	};

	const response = await fetch(url.toString(), {
		method,
		headers,
		body: fetchBody,
		signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`HTTP ${response.status}: ${text}`);
	}

	const contentType = response.headers.get('content-type') ?? '';

	if (contentType.startsWith('application/json')) {
		const json = await response.json();
		if (json.error) {
			throw new Error(json.error);
		}
		return json as CompletionInfo;
	}

	if (!contentType.includes('multipart/mixed')) {
		throw new Error(`Unexpected Content-Type: ${contentType}`);
	}

	const boundary = extractBoundary(contentType);
	const queue: ParsedChunk[] = [];
	let resolve: (() => void) | null = null;
	let completionInfo: CompletionInfo | undefined;

	const parser = new MultipartStreamParser(boundary, (part) => {
		const chunkType = (part.headers['x-chunk-type'] ?? 'error') as ChunkType;
		const chunk: ParsedChunk = {
			type: chunkType,
			headers: part.headers,
			body: part.body,
		};
		queue.push(chunk);
		if (resolve) {
			resolve();
			resolve = null;
		}
	});

	const reader = response.body!.getReader();
	let readerDone = false;

	while (true) {
		// Yield any queued chunks
		while (queue.length > 0) {
			const chunk = queue.shift()!;
			if (chunk.type === 'completion') {
				completionInfo = parseCompletionChunk(chunk);
			} else {
				yield chunk;
			}
		}

		if (readerDone) {
			break;
		}

		// Read more data
		const { done, value } = await reader.read();
		if (done) {
			readerDone = true;
			continue;
		}
		parser.feed(value);
	}

	return completionInfo;
}

function parseCompletionChunk(chunk: ParsedChunk): CompletionInfo {
	const json = JSON.parse(new TextDecoder().decode(chunk.body));
	return {
		status: json.status ?? 'complete',
		cursor: json.cursor ?? null,
		serverStats: json.server_stats,
	};
}
