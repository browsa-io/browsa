import { createHmac, timingSafeEqual } from 'crypto';

/** Deliveries older than this are refused, so a captured one cannot be replayed later. */
export const SIGNATURE_SKEW_SECONDS = 300;

/** Splits `t=<unix>, v1=<hex>` into its parts. */
export function parseSignatureHeader(header: string): { t: string; v1: string } {
	let t = '';
	let v1 = '';
	for (const part of (header || '').split(',')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k === 't') t = v;
		else if (k === 'v1') v1 = v;
	}
	return { t, v1 };
}

/**
 * Checks Browsa's `X-Agents-Signature` header:
 * v1 = HMAC-SHA256(secret, "<t>.<raw body>"), the secret given as hex by
 * GET /v1/webhooks/signing-secret. Constant-time compare, 5 minute window.
 */
export function verifySignature(
	rawBody: Buffer | string,
	header: string,
	secretHex: string,
	nowSeconds = Math.floor(Date.now() / 1000),
	skewSeconds = SIGNATURE_SKEW_SECONDS,
): boolean {
	const { t, v1 } = parseSignatureHeader(header);
	if (!t || !v1 || !secretHex) return false;
	const unix = Number(t);
	if (!Number.isFinite(unix) || unix <= 0) return false;
	if (skewSeconds > 0 && Math.abs(nowSeconds - unix) > skewSeconds) return false;

	const key =
		/^[0-9a-fA-F]+$/.test(secretHex) && secretHex.length % 2 === 0
			? Buffer.from(secretHex, 'hex')
			: Buffer.from(secretHex, 'utf-8');
	const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody;
	const expected = createHmac('sha256', key)
		.update(Buffer.concat([Buffer.from(`${t}.`, 'utf-8'), body]))
		.digest('hex');
	if (expected.length !== v1.length) return false;
	return timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(v1, 'utf-8'));
}
