import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { HmacClient } from '../src/hmac.js';

// Polyfill crypto.subtle for Node.js environments that don't expose it globally
beforeAll(() => {
	if (!globalThis.crypto?.subtle) {
		const { webcrypto } = require('node:crypto');
		Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
	}
});

describe('HmacClient', () => {
	const secret = 'test-secret-key';
	let client: HmacClient;

	beforeAll(() => {
		client = new HmacClient(secret);
	});

	describe('sha256', () => {
		it('hashes empty string to known value', async () => {
			const hash = await client.sha256('');
			expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		});

		it('hashes "hello" to known value', async () => {
			const hash = await client.sha256('hello');
			expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
		});
	});

	describe('generateNonce', () => {
		it('returns a 32-char hex string', async () => {
			const nonce = await client.generateNonce();
			expect(nonce).toMatch(/^[0-9a-f]{32}$/);
		});

		it('returns unique values', async () => {
			const nonce1 = await client.generateNonce();
			const nonce2 = await client.generateNonce();
			expect(nonce1).not.toBe(nonce2);
		});
	});

	describe('getTimestamp', () => {
		it('returns a numeric string with decimal point', () => {
			const ts = client.getTimestamp();
			expect(ts).toMatch(/^\d+\.\d{6}$/);
		});

		it('is close to current time', () => {
			const ts = parseFloat(client.getTimestamp());
			const now = Date.now() / 1000;
			expect(Math.abs(ts - now)).toBeLessThan(1);
		});
	});

	describe('getAuthHeaders', () => {
		it('returns all 4 required header keys', async () => {
			const headers = await client.getAuthHeaders('test body');
			expect(headers).toHaveProperty('X-Auth-Signature');
			expect(headers).toHaveProperty('X-Auth-Nonce');
			expect(headers).toHaveProperty('X-Auth-Timestamp');
			expect(headers).toHaveProperty('X-Auth-Content-Hash');
		});

		it('content hash matches sha256 of body', async () => {
			const body = 'test body content';
			const headers = await client.getAuthHeaders(body);
			const expectedHash = await client.sha256(body);
			expect(headers['X-Auth-Content-Hash']).toBe(expectedHash);
		});

		it('handles empty body', async () => {
			const headers = await client.getAuthHeaders();
			const emptyHash = await client.sha256('');
			expect(headers['X-Auth-Content-Hash']).toBe(emptyHash);
		});
	});

	describe('computeSignature', () => {
		it('is deterministic for same inputs', async () => {
			const nonce = 'a'.repeat(32);
			const timestamp = '1700000000.000000';
			const contentHash = await client.sha256('body');

			const sig1 = await client.computeSignature(nonce, timestamp, contentHash);
			const sig2 = await client.computeSignature(nonce, timestamp, contentHash);
			expect(sig1).toBe(sig2);
		});

		it('produces valid hex string', async () => {
			const sig = await client.computeSignature('a'.repeat(32), '1700000000.000000');
			expect(sig).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	describe('cross-validation with Node.js crypto', () => {
		it('sha256 matches Node.js createHash', async () => {
			const data = 'cross-validation test data';
			const webCryptoHash = await client.sha256(data);
			const nodeHash = createHash('sha256').update(data).digest('hex');
			expect(webCryptoHash).toBe(nodeHash);
		});

		it('HMAC signature matches Node.js createHmac', async () => {
			const nonce = 'deadbeef'.repeat(4);
			const timestamp = '1700000000.000000';
			const contentHash = createHash('sha256').update('test body').digest('hex');

			const webCryptoSig = await client.computeSignature(nonce, timestamp, contentHash);

			const message = nonce + timestamp + contentHash;
			const nodeSig = createHmac('sha256', secret).update(message).digest('hex');

			expect(webCryptoSig).toBe(nodeSig);
		});
	});
});
