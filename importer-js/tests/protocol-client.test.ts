import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamEndpoint } from '../src/protocol-client';
import type { ImportConfig, ParsedChunk, CompletionInfo } from '../src/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const config: ImportConfig = {
	remoteUrl: 'https://example.com/export',
	secret: 'test-secret-key',
};

function buildMultipartResponse(
	boundary: string,
	parts: Array<{ headers: Record<string, string>; body: string | Uint8Array }>,
	close = true,
): Uint8Array {
	const chunks: Uint8Array[] = [];
	for (const part of parts) {
		chunks.push(encoder.encode(`--${boundary}\r\n`));
		for (const [key, value] of Object.entries(part.headers)) {
			chunks.push(encoder.encode(`${key}: ${value}\r\n`));
		}
		const bodyBytes =
			typeof part.body === 'string' ? encoder.encode(part.body) : part.body;
		chunks.push(encoder.encode(`Content-Length: ${bodyBytes.length}\r\n`));
		chunks.push(encoder.encode('\r\n'));
		chunks.push(bodyBytes);
		chunks.push(encoder.encode('\r\n'));
	}
	if (close) {
		chunks.push(encoder.encode(`--${boundary}--\r\n`));
	}
	let total = 0;
	for (const c of chunks) total += c.length;
	const result = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.length;
	}
	return result;
}

function mockFetchResponse(
	body: Uint8Array,
	contentType: string,
	status = 200,
): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		statusText: status === 200 ? 'OK' : 'Error',
		headers: { 'Content-Type': contentType },
	});
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('streamEndpoint', () => {
	it('sends correct HMAC auth headers on GET request', async () => {
		const boundary = 'test-boundary';
		const completion = JSON.stringify({ status: 'complete', cursor: null });
		const body = buildMultipartResponse(boundary, [
			{
				headers: { 'X-Chunk-Type': 'completion' },
				body: completion,
			},
		]);

		globalThis.fetch = vi.fn().mockResolvedValue(
			mockFetchResponse(body, `multipart/mixed; boundary=${boundary}`),
		);

		const gen = streamEndpoint(config, 'preflight', null);
		// Drain the generator
		while (true) {
			const { done } = await gen.next();
			if (done) break;
		}

		expect(globalThis.fetch).toHaveBeenCalledOnce();
		const [, fetchOptions] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const headers = fetchOptions.headers as Record<string, string>;
		expect(headers).toHaveProperty('X-Auth-Signature');
		expect(headers).toHaveProperty('X-Auth-Nonce');
		expect(headers).toHaveProperty('X-Auth-Timestamp');
		expect(headers).toHaveProperty('X-Auth-Content-Hash');
	});

	it('base64-encodes cursor in URL params', async () => {
		const boundary = 'b';
		const body = buildMultipartResponse(boundary, [
			{
				headers: { 'X-Chunk-Type': 'completion' },
				body: JSON.stringify({ status: 'complete', cursor: null }),
			},
		]);

		globalThis.fetch = vi.fn().mockResolvedValue(
			mockFetchResponse(body, `multipart/mixed; boundary=${boundary}`),
		);

		const cursor = '{"table":"wp_posts","pk":42}';
		const gen = streamEndpoint(config, 'sql_chunk', cursor);
		while (true) {
			const { done } = await gen.next();
			if (done) break;
		}

		const [urlStr] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const url = new URL(urlStr);
		expect(url.searchParams.get('cursor')).toBe(btoa(cursor));
	});

	it('includes additional params in URL', async () => {
		const boundary = 'b';
		const body = buildMultipartResponse(boundary, [
			{
				headers: { 'X-Chunk-Type': 'completion' },
				body: JSON.stringify({ status: 'complete', cursor: null }),
			},
		]);

		globalThis.fetch = vi.fn().mockResolvedValue(
			mockFetchResponse(body, `multipart/mixed; boundary=${boundary}`),
		);

		const gen = streamEndpoint(config, 'file_index', null, {
			batch_size: '5000',
			prefix: '/uploads',
		});
		while (true) {
			const { done } = await gen.next();
			if (done) break;
		}

		const [urlStr] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const url = new URL(urlStr);
		expect(url.searchParams.get('batch_size')).toBe('5000');
		expect(url.searchParams.get('prefix')).toBe('/uploads');
		expect(url.searchParams.get('endpoint')).toBe('file_index');
	});

	it('sends FormData body for POST file_fetch', async () => {
		const boundary = 'b';
		const respBody = buildMultipartResponse(boundary, [
			{
				headers: { 'X-Chunk-Type': 'completion' },
				body: JSON.stringify({ status: 'complete', cursor: null }),
			},
		]);

		globalThis.fetch = vi.fn().mockResolvedValue(
			mockFetchResponse(respBody, `multipart/mixed; boundary=${boundary}`),
		);

		const fileList = encoder.encode('["/path/to/file.jpg"]');
		const gen = streamEndpoint(config, 'file_fetch', null, undefined, fileList);
		while (true) {
			const { done } = await gen.next();
			if (done) break;
		}

		const [, fetchOptions] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(fetchOptions.method).toBe('POST');
		expect(fetchOptions.body).toBeInstanceOf(FormData);

		const formData = fetchOptions.body as FormData;
		const blob = formData.get('file_list') as Blob;
		expect(blob).toBeInstanceOf(Blob);
		const blobText = await blob.text();
		expect(blobText).toBe('["/path/to/file.jpg"]');
	});

	it('yields correct ParsedChunks from multipart response', async () => {
		const boundary = 'chunk-boundary';
		const body = buildMultipartResponse(boundary, [
			{
				headers: { 'X-Chunk-Type': 'metadata' },
				body: '{"version":"1.0"}',
			},
			{
				headers: { 'X-Chunk-Type': 'index_batch' },
				body: '{"files":["a.txt","b.txt"]}',
			},
			{
				headers: { 'X-Chunk-Type': 'completion' },
				body: JSON.stringify({ status: 'complete', cursor: null }),
			},
		]);

		globalThis.fetch = vi.fn().mockResolvedValue(
			mockFetchResponse(body, `multipart/mixed; boundary=${boundary}`),
		);

		const gen = streamEndpoint(config, 'preflight', null);
		const chunks: ParsedChunk[] = [];
		while (true) {
			const { done, value } = await gen.next();
			if (done) break;
			chunks.push(value);
		}

		expect(chunks).toHaveLength(2);
		expect(chunks[0].type).toBe('metadata');
		expect(decoder.decode(chunks[0].body)).toBe('{"version":"1.0"}');
		expect(chunks[1].type).toBe('index_batch');
		expect(decoder.decode(chunks[1].body)).toBe('{"files":["a.txt","b.txt"]}');
	});

	it('returns CompletionInfo with cursor from completion chunk', async () => {
		const boundary = 'b';
		const body = buildMultipartResponse(boundary, [
			{
				headers: { 'X-Chunk-Type': 'progress' },
				body: '{}',
			},
			{
				headers: {
					'X-Chunk-Type': 'completion',
					'X-Status': 'partial',
					'X-Cursor': btoa('{"table":"wp_posts","pk":100}'),
				},
				body: '',
			},
		]);

		globalThis.fetch = vi.fn().mockResolvedValue(
			mockFetchResponse(body, `multipart/mixed; boundary=${boundary}`),
		);

		const gen = streamEndpoint(config, 'sql_chunk', null);
		let returnValue: CompletionInfo | undefined;
		while (true) {
			const iterResult = await gen.next();
			if (iterResult.done) {
				returnValue = iterResult.value;
				break;
			}
		}

		expect(returnValue).toBeDefined();
		expect(returnValue!.status).toBe('partial');
		expect(returnValue!.cursor).toBe('{"table":"wp_posts","pk":100}');
	});

	it('throws on non-2xx response', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response('Internal Server Error', {
				status: 500,
				statusText: 'Internal Server Error',
			}),
		);

		const gen = streamEndpoint(config, 'preflight', null);
		await expect(gen.next()).rejects.toThrow('HTTP 500');
	});

	it('throws on JSON error response', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: 'Invalid secret' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const gen = streamEndpoint(config, 'preflight', null);
		await expect(gen.next()).rejects.toThrow('Invalid secret');
	});

	it('respects AbortSignal', async () => {
		const controller = new AbortController();
		controller.abort();

		globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

		const gen = streamEndpoint(config, 'preflight', null, undefined, undefined, controller.signal);
		await expect(gen.next()).rejects.toThrow();

		const [, fetchOptions] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(fetchOptions.signal).toBe(controller.signal);
	});
});
