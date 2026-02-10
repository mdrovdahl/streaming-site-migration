export interface ParsedPart {
  headers: Record<string, string>;
  body: Uint8Array;
}

type ParserState = 'boundary' | 'headers' | 'body';

export class MultipartStreamParser {
  private static readonly MAX_BUFFER_SIZE = 64 * 1024 * 1024; // 64MB

  private boundary: Uint8Array; // "--" + boundary as bytes
  private boundaryLength: number;
  private buffer: Uint8Array;
  private bufferLen: number;
  private state: ParserState;
  private currentHeaders: Record<string, string>;
  private bodyChunks: Uint8Array[];
  private bodyTarget: number | null;
  private bodyLength: number;
  private onPart: (part: ParsedPart) => void;

  constructor(boundary: string, onPart: (part: ParsedPart) => void) {
    const encoder = new TextEncoder();
    this.boundary = encoder.encode('--' + boundary);
    this.boundaryLength = this.boundary.length;
    this.buffer = new Uint8Array(0);
    this.bufferLen = 0;
    this.state = 'boundary';
    this.currentHeaders = {};
    this.bodyChunks = [];
    this.bodyTarget = null;
    this.bodyLength = 0;
    this.onPart = onPart;
  }

  feed(data: Uint8Array): void {
    this.appendToBuffer(data);
    if (this.bufferLen > MultipartStreamParser.MAX_BUFFER_SIZE) {
      throw new Error(
        'Multipart parser buffer exceeded 64MB — response may be malformed (missing boundary delimiter).'
      );
    }
    this.parse();
  }

  private appendToBuffer(data: Uint8Array): void {
    const newBuf = new Uint8Array(this.bufferLen + data.length);
    newBuf.set(this.buffer.subarray(0, this.bufferLen), 0);
    newBuf.set(data, this.bufferLen);
    this.bufferLen += data.length;
    this.buffer = newBuf;
  }

  private consumeBuffer(count: number): void {
    this.buffer = this.buffer.slice(count);
    this.bufferLen -= count;
  }

  private parse(): void {
    while (true) {
      if (this.state === 'boundary') {
        if (!this.parseBoundary()) break;
      } else if (this.state === 'headers') {
        if (!this.parseHeaders()) break;
      } else if (this.state === 'body') {
        if (!this.parseBody()) break;
      }
    }
  }

  private parseBoundary(): boolean {
    const pos = this.indexOf(this.boundary);
    if (pos === -1) {
      // Keep only last boundaryLength bytes in case boundary is split
      if (this.bufferLen > this.boundaryLength) {
        this.consumeBuffer(this.bufferLen - this.boundaryLength);
      }
      return false;
    }

    // Check if this is the closing boundary (--boundary--)
    const afterBoundary = pos + this.boundaryLength;
    if (afterBoundary + 2 <= this.bufferLen) {
      if (
        this.buffer[afterBoundary] === 0x2d && // '-'
        this.buffer[afterBoundary + 1] === 0x2d // '-'
      ) {
        // Closing boundary - done
        this.bufferLen = 0;
        this.buffer = new Uint8Array(0);
        return false;
      }
    }

    // Find end of line after boundary (\r\n or \n)
    const lineEnd = this.findLineEnd(afterBoundary);
    if (lineEnd === -1) {
      return false; // Need more data
    }

    // Consume boundary line
    this.consumeBuffer(lineEnd);
    this.state = 'headers';
    this.currentHeaders = {};
    return true;
  }

  private parseHeaders(): boolean {
    while (true) {
      // Check for blank line (end of headers)
      if (this.bufferLen >= 2) {
        if (this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
          // \r\n - blank line
          this.consumeBuffer(2);
          this.prepareBody();
          return true;
        }
      }
      if (this.bufferLen >= 1 && this.buffer[0] === 0x0a) {
        // \n - blank line
        this.consumeBuffer(1);
        this.prepareBody();
        return true;
      }

      // Find end of line
      const lineEnd = this.findLineEnd(0);
      if (lineEnd === -1) {
        return false; // Need more data
      }

      // Extract header line
      const lineBytes = this.buffer.slice(0, lineEnd);
      this.consumeBuffer(lineEnd);

      // Trim line endings
      let lineLen = lineBytes.length;
      while (
        lineLen > 0 &&
        (lineBytes[lineLen - 1] === 0x0d || lineBytes[lineLen - 1] === 0x0a)
      ) {
        lineLen--;
      }

      if (lineLen === 0) {
        // Blank line - end of headers
        this.prepareBody();
        return true;
      }

      // Parse header (find first colon)
      const line = new TextDecoder().decode(lineBytes.subarray(0, lineLen));
      const colonPos = line.indexOf(':');
      if (colonPos !== -1) {
        const name = line.substring(0, colonPos).trim();
        const value = line.substring(colonPos + 1).trimStart();
        this.currentHeaders[name.toLowerCase()] = value;
      }
    }
  }

  private prepareBody(): void {
    this.state = 'body';
    this.bodyChunks = [];
    this.bodyLength = 0;
    this.bodyTarget =
      'content-length' in this.currentHeaders
        ? parseInt(this.currentHeaders['content-length'], 10)
        : null;
  }

  private parseBody(): boolean {
    if (this.bodyTarget !== null) {
      return this.parseBodyWithLength();
    }
    return this.parseBodyWithoutLength();
  }

  private parseBodyWithLength(): boolean {
    const remaining = this.bodyTarget! - this.bodyLength;

    if (this.bufferLen < remaining) {
      // Need more data — accumulate what we have
      if (this.bufferLen > 0) {
        this.bodyChunks.push(this.buffer.slice(0, this.bufferLen));
        this.bodyLength += this.bufferLen;
        this.bufferLen = 0;
        this.buffer = new Uint8Array(0);
      }
      return false;
    }

    // We have enough data
    this.bodyChunks.push(this.buffer.slice(0, remaining));
    this.bodyLength += remaining;
    this.consumeBuffer(remaining);

    // Skip trailing \r\n after body
    this.skipCrlf();

    // Emit complete part
    this.state = 'boundary';
    this.emitPart();
    return true;
  }

  private parseBodyWithoutLength(): boolean {
    // Look for boundary in buffer preceded by \r\n or \n
    let boundaryPos = this.indexOfWithPrefix(this.boundary, 0x0d, 0x0a); // \r\n + boundary
    let prefixLen = 2;

    if (boundaryPos === -1) {
      boundaryPos = this.indexOfWithPrefix1(this.boundary, 0x0a); // \n + boundary
      prefixLen = 1;
    }

    if (boundaryPos === -1) {
      // No boundary yet - process all but last (boundaryLength + 2) bytes
      const safeLength = this.bufferLen - this.boundaryLength - 2;
      if (safeLength > 0) {
        this.bodyChunks.push(this.buffer.slice(0, safeLength));
        this.bodyLength += safeLength;
        this.consumeBuffer(safeLength);
      }
      return false;
    }

    // Found boundary - emit remaining body (before the \r\n/\n prefix)
    if (boundaryPos > 0) {
      this.bodyChunks.push(this.buffer.slice(0, boundaryPos));
      this.bodyLength += boundaryPos;
    }
    this.consumeBuffer(boundaryPos);

    // Skip \r\n or \n before boundary
    this.skipCrlf();

    // Emit complete part, move to boundary state
    this.state = 'boundary';
    this.emitPart();
    return true;
  }

  private emitPart(): void {
    const body = this.concatChunks(this.bodyChunks);
    this.onPart({
      headers: { ...this.currentHeaders },
      body,
    });
    this.bodyChunks = [];
  }

  private concatChunks(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];
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

  private skipCrlf(): void {
    if (
      this.bufferLen >= 2 &&
      this.buffer[0] === 0x0d &&
      this.buffer[1] === 0x0a
    ) {
      this.consumeBuffer(2);
    } else if (this.bufferLen >= 1 && this.buffer[0] === 0x0a) {
      this.consumeBuffer(1);
    }
  }

  private findLineEnd(offset: number): number {
    for (let i = offset; i < this.bufferLen; i++) {
      if (this.buffer[i] === 0x0a) {
        return i + 1;
      }
      if (
        this.buffer[i] === 0x0d &&
        i + 1 < this.bufferLen &&
        this.buffer[i + 1] === 0x0a
      ) {
        return i + 2;
      }
    }
    return -1;
  }

  private indexOf(needle: Uint8Array): number {
    const needleLen = needle.length;
    const limit = this.bufferLen - needleLen;
    outer: for (let i = 0; i <= limit; i++) {
      for (let j = 0; j < needleLen; j++) {
        if (this.buffer[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // Search for prefix byte1 + byte2 + needle
  private indexOfWithPrefix(
    needle: Uint8Array,
    byte1: number,
    byte2: number
  ): number {
    const totalLen = 2 + needle.length;
    const limit = this.bufferLen - totalLen;
    outer: for (let i = 0; i <= limit; i++) {
      if (this.buffer[i] !== byte1 || this.buffer[i + 1] !== byte2)
        continue;
      for (let j = 0; j < needle.length; j++) {
        if (this.buffer[i + 2 + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // Search for prefix byte1 + needle
  private indexOfWithPrefix1(needle: Uint8Array, byte1: number): number {
    const totalLen = 1 + needle.length;
    const limit = this.bufferLen - totalLen;
    outer: for (let i = 0; i <= limit; i++) {
      if (this.buffer[i] !== byte1) continue;
      for (let j = 0; j < needle.length; j++) {
        if (this.buffer[i + 1 + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}

export function extractBoundary(contentType: string): string {
  const match = contentType.match(/boundary="?([^";\s]+)"?/);
  if (!match) {
    throw new Error(
      `Could not extract boundary from Content-Type: ${contentType}`
    );
  }
  return match[1];
}
