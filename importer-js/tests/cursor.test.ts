import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, decodeBase64Path, mapServerPath } from '../src/cursor';

describe('cursor utilities', () => {
  it('round-trips encode/decode of JSON cursor', () => {
    const json = '{"table":"wp_posts","pk":42}';
    const encoded = encodeCursor(json);
    expect(decodeCursor(encoded)).toBe(json);
  });

  it('decodes a base64-encoded file path', () => {
    const path = '/var/www/html/wp-content/uploads/photo.jpg';
    const encoded = btoa(path);
    expect(decodeBase64Path(encoded)).toBe(path);
  });

  it('maps a server path to a local path', () => {
    const result = mapServerPath(
      '/var/www/html/wp-content/file.php',
      '/var/www/html',
      '/wordpress'
    );
    expect(result).toBe('/wordpress/wp-content/file.php');
  });

  it('throws when server path does not match server root', () => {
    expect(() =>
      mapServerPath('/other/path/file.php', '/var/www/html', '/wordpress')
    ).toThrow('Server path "/other/path/file.php" does not start with server root "/var/www/html"');
  });

  it('round-trips an empty cursor string', () => {
    const encoded = encodeCursor('');
    expect(decodeCursor(encoded)).toBe('');
  });

  it('handles trailing slashes on localRoot correctly', () => {
    const result = mapServerPath(
      '/var/www/html/wp-content/file.php',
      '/var/www/html',
      '/wordpress/'
    );
    expect(result).toBe('/wordpress/wp-content/file.php');
  });
});
