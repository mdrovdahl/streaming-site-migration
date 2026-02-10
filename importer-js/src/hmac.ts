/**
 * HMAC authentication client for Site Export API.
 * Web Crypto API implementation matching the PHP Site_Export_HMAC_Client.
 *
 * Signature = HMAC-SHA256(nonce + timestamp + SHA256(body), secret)
 */

function hexEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = '';
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0');
	}
	return hex;
}

export class HmacClient {
	private secret: string;

	constructor(secret: string) {
		this.secret = secret;
	}

	/**
	 * Generate a cryptographically secure nonce (hex string, 32 chars).
	 */
	async generateNonce(): Promise<string> {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		return hexEncode(bytes.buffer);
	}

	/**
	 * Get current timestamp with microsecond precision.
	 */
	getTimestamp(): string {
		return (Date.now() / 1000).toFixed(6);
	}

	/**
	 * Compute SHA-256 hash of data.
	 */
	async sha256(data: string): Promise<string> {
		const encoded = new TextEncoder().encode(data);
		const hash = await crypto.subtle.digest('SHA-256', encoded);
		return hexEncode(hash);
	}

	/**
	 * Compute HMAC-SHA256 signature.
	 */
	async computeSignature(nonce: string, timestamp: string, contentHash?: string): Promise<string> {
		if (!contentHash) {
			contentHash = await this.sha256('');
		}
		const message = nonce + timestamp + contentHash;

		const keyData = new TextEncoder().encode(this.secret);
		const key = await crypto.subtle.importKey(
			'raw',
			keyData,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);

		const messageData = new TextEncoder().encode(message);
		const signature = await crypto.subtle.sign('HMAC', key, messageData);
		return hexEncode(signature);
	}

	/**
	 * Get all authentication headers for a request.
	 */
	async getAuthHeaders(body?: string): Promise<Record<string, string>> {
		const nonce = await this.generateNonce();
		const timestamp = this.getTimestamp();
		const bodyStr = body ?? '';
		const contentHash = await this.sha256(bodyStr);
		const signature = await this.computeSignature(nonce, timestamp, contentHash);

		return {
			'X-Auth-Signature': signature,
			'X-Auth-Nonce': nonce,
			'X-Auth-Timestamp': timestamp,
			'X-Auth-Content-Hash': contentHash,
		};
	}
}
