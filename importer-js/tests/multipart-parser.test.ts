import { describe, it, expect } from 'vitest';
import {
  MultipartStreamParser,
  ParsedPart,
  extractBoundary,
} from '../src/multipart-parser.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(str: string): Uint8Array {
  return encoder.encode(str);
}

function decode(buf: Uint8Array): string {
  return decoder.decode(buf);
}

function buildMultipart(
  boundary: string,
  parts: { headers: Record<string, string>; body: string | Uint8Array }[]
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(encode('--' + boundary + '\r\n'));
    for (const [key, value] of Object.entries(part.headers)) {
      chunks.push(encode(key + ': ' + value + '\r\n'));
    }
    chunks.push(encode('\r\n'));
    const body =
      typeof part.body === 'string' ? encode(part.body) : part.body;
    chunks.push(body);
    chunks.push(encode('\r\n'));
  }
  chunks.push(encode('--' + boundary + '--\r\n'));

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

describe('MultipartStreamParser', () => {
  it('should parse simple 2-part multipart with Content-Length bodies', () => {
    const boundary = 'test-boundary-123';
    const body1 = 'Hello, World!';
    const body2 = '{"key": "value"}';

    const payload = buildMultipart(boundary, [
      {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(encode(body1).length),
        },
        body: body1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(encode(body2).length),
        },
        body: body2,
      },
    ]);

    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );
    parser.feed(payload);

    expect(parts).toHaveLength(2);
    expect(parts[0].headers['content-type']).toBe('text/plain');
    expect(decode(parts[0].body)).toBe(body1);
    expect(parts[1].headers['content-type']).toBe('application/json');
    expect(decode(parts[1].body)).toBe(body2);
  });

  it('should parse multipart without Content-Length (boundary-delimited)', () => {
    const boundary = 'no-length-boundary';
    const body1 = 'first part body without length';
    const body2 = 'second part body without length';

    const payload = buildMultipart(boundary, [
      { headers: { 'Content-Type': 'text/plain' }, body: body1 },
      { headers: { 'Content-Type': 'text/html' }, body: body2 },
    ]);

    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );
    parser.feed(payload);

    expect(parts).toHaveLength(2);
    expect(decode(parts[0].body)).toBe(body1);
    expect(decode(parts[1].body)).toBe(body2);
  });

  it('should parse multipart with binary body (non-UTF8 bytes)', () => {
    const boundary = 'binary-boundary';
    const binaryBody = new Uint8Array([
      0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x90, 0xa0, 0xb0, 0xc0,
      0xd0, 0xe0, 0xf0,
    ]);

    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );

    // Build manually to handle binary body with Content-Length
    const header = `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${binaryBody.length}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;

    const headerBytes = encode(header);
    const closingBytes = encode(closing);
    const payload = new Uint8Array(
      headerBytes.length + binaryBody.length + closingBytes.length
    );
    payload.set(headerBytes, 0);
    payload.set(binaryBody, headerBytes.length);
    payload.set(closingBytes, headerBytes.length + binaryBody.length);

    parser.feed(payload);

    expect(parts).toHaveLength(1);
    expect(parts[0].headers['content-type']).toBe('application/octet-stream');
    expect(parts[0].body).toEqual(binaryBody);
  });

  it('should parse with various chunk types (x-chunk-type header)', () => {
    const boundary = 'chunk-type-boundary';

    const payload = buildMultipart(boundary, [
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Chunk-Type': 'header',
          'Content-Length': '2',
        },
        body: '{}',
      },
      {
        headers: {
          'Content-Type': 'application/sql',
          'X-Chunk-Type': 'table_data',
          'Content-Length': '24',
        },
        body: 'INSERT INTO t VALUES (1)',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Chunk-Type': 'footer',
          'Content-Length': '2',
        },
        body: '{}',
      },
    ]);

    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );
    parser.feed(payload);

    expect(parts).toHaveLength(3);
    expect(parts[0].headers['x-chunk-type']).toBe('header');
    expect(parts[1].headers['x-chunk-type']).toBe('table_data');
    expect(parts[2].headers['x-chunk-type']).toBe('footer');
  });

  it('should handle incremental feeding at arbitrary byte offsets', () => {
    const boundary = 'incremental-boundary';
    const body1 = 'Hello from part one';
    const body2 = 'Hello from part two';

    const payload = buildMultipart(boundary, [
      {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(encode(body1).length),
        },
        body: body1,
      },
      {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(encode(body2).length),
        },
        body: body2,
      },
    ]);

    // Feed one byte at a time
    const parts1: ParsedPart[] = [];
    const parser1 = new MultipartStreamParser(boundary, (part) =>
      parts1.push(part)
    );
    for (let i = 0; i < payload.length; i++) {
      parser1.feed(payload.subarray(i, i + 1));
    }
    expect(parts1).toHaveLength(2);
    expect(decode(parts1[0].body)).toBe(body1);
    expect(decode(parts1[1].body)).toBe(body2);

    // Feed in chunks of 7 (prime number to stress split points)
    const parts2: ParsedPart[] = [];
    const parser2 = new MultipartStreamParser(boundary, (part) =>
      parts2.push(part)
    );
    for (let i = 0; i < payload.length; i += 7) {
      parser2.feed(payload.subarray(i, Math.min(i + 7, payload.length)));
    }
    expect(parts2).toHaveLength(2);
    expect(decode(parts2[0].body)).toBe(body1);
    expect(decode(parts2[1].body)).toBe(body2);

    // Feed in chunks of 3 (splits mid-boundary, mid-header, mid-body)
    const parts3: ParsedPart[] = [];
    const parser3 = new MultipartStreamParser(boundary, (part) =>
      parts3.push(part)
    );
    for (let i = 0; i < payload.length; i += 3) {
      parser3.feed(payload.subarray(i, Math.min(i + 3, payload.length)));
    }
    expect(parts3).toHaveLength(2);
    expect(decode(parts3[0].body)).toBe(body1);
    expect(decode(parts3[1].body)).toBe(body2);
  });

  it('should handle incremental feeding without Content-Length', () => {
    const boundary = 'incremental-no-cl';
    const body1 = 'Body without content length one';
    const body2 = 'Body without content length two';

    const payload = buildMultipart(boundary, [
      { headers: { 'Content-Type': 'text/plain' }, body: body1 },
      { headers: { 'Content-Type': 'text/plain' }, body: body2 },
    ]);

    // Feed one byte at a time
    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );
    for (let i = 0; i < payload.length; i++) {
      parser.feed(payload.subarray(i, i + 1));
    }
    expect(parts).toHaveLength(2);
    expect(decode(parts[0].body)).toBe(body1);
    expect(decode(parts[1].body)).toBe(body2);
  });

  it('should handle empty body part', () => {
    const boundary = 'empty-body-boundary';

    const payload = buildMultipart(boundary, [
      {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '0',
        },
        body: '',
      },
    ]);

    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );
    parser.feed(payload);

    expect(parts).toHaveLength(1);
    expect(parts[0].body.length).toBe(0);
  });

  it('should stop parsing at closing boundary', () => {
    const boundary = 'closing-boundary';

    // Build with closing boundary, then add garbage after
    const payload = buildMultipart(boundary, [
      {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '5',
        },
        body: 'hello',
      },
    ]);

    // Append garbage after closing boundary
    const garbage = encode('THIS SHOULD BE IGNORED');
    const combined = new Uint8Array(payload.length + garbage.length);
    combined.set(payload, 0);
    combined.set(garbage, payload.length);

    const parts: ParsedPart[] = [];
    const parser = new MultipartStreamParser(boundary, (part) =>
      parts.push(part)
    );
    parser.feed(combined);

    expect(parts).toHaveLength(1);
    expect(decode(parts[0].body)).toBe('hello');
  });

  it('should throw on buffer overflow (>64MB without boundary)', () => {
    const boundary = 'overflow-boundary';
    const parser = new MultipartStreamParser(boundary, () => {});

    // First, feed a boundary + start of headers to enter headers state
    // Then feed data with no line endings so the buffer accumulates
    const intro = encode('--' + boundary + '\r\n');
    parser.feed(intro);

    // Now in headers state, feed chunks without \r\n — buffer grows unbounded
    const chunkSize = 1024 * 1024; // 1MB
    const chunk = new Uint8Array(chunkSize);
    chunk.fill(0x41); // 'A' — no line endings

    expect(() => {
      for (let i = 0; i < 65; i++) {
        parser.feed(chunk);
      }
    }).toThrow(/buffer exceeded 64MB/);
  });

  describe('extractBoundary', () => {
    it('should extract boundary without quotes', () => {
      expect(
        extractBoundary('multipart/mixed; boundary=abc123')
      ).toBe('abc123');
    });

    it('should extract boundary with quotes', () => {
      expect(
        extractBoundary('multipart/mixed; boundary="abc123"')
      ).toBe('abc123');
    });

    it('should extract boundary with additional params', () => {
      expect(
        extractBoundary(
          'multipart/mixed; boundary=abc123; charset=utf-8'
        )
      ).toBe('abc123');
    });

    it('should throw for missing boundary', () => {
      expect(() => extractBoundary('text/plain')).toThrow(
        /Could not extract boundary/
      );
    });
  });
});
