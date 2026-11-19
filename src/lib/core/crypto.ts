// SPDX-License-Identifier: MIT
// Passphrase-based authenticated encryption for the R6 envelope.
//
// Envelope layout (all bytes):
//   [0]            envelope version (1)
//   [1]            scrypt log2(N)
//   [2..18)        salt (16)
//   [18..42)       nonce (24)
//   [42..]         XChaCha20-Poly1305 ciphertext + 16-byte tag
// AAD = R4 || R5, so the public section cannot be swapped under the ciphertext.

import { scrypt } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import {
	ENVELOPE_VERSION,
	NONCE_LEN,
	SALT_LEN,
	SCRYPT_LOG_N,
	SCRYPT_P,
	SCRYPT_R
} from './constants';

const enc = new TextEncoder();

export class DecryptError extends Error {
	constructor(message = 'Could not decrypt: wrong secret or corrupted data.') {
		super(message);
		this.name = 'DecryptError';
	}
}

function deriveKey(secret: string, salt: Uint8Array, logN: number): Uint8Array {
	if (!secret) throw new Error('A non-empty secret is required.');
	return scrypt(enc.encode(secret.normalize('NFKC')), salt, {
		N: 2 ** logN,
		r: SCRYPT_R,
		p: SCRYPT_P,
		dkLen: 32
	});
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function sealEnvelope(plaintext: Uint8Array, secret: string, aad: Uint8Array): Uint8Array {
	const salt = randomBytes(SALT_LEN);
	const nonce = randomBytes(NONCE_LEN);
	const key = deriveKey(secret, salt, SCRYPT_LOG_N);
	const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
	return concat(new Uint8Array([ENVELOPE_VERSION, SCRYPT_LOG_N]), salt, nonce, ct);
}

export function openEnvelope(envelope: Uint8Array, secret: string, aad: Uint8Array): Uint8Array {
	const headLen = 2 + SALT_LEN + NONCE_LEN;
	if (envelope.length < headLen + 16) throw new DecryptError('Envelope is too short.');
	if (envelope[0] !== ENVELOPE_VERSION) {
		throw new DecryptError(`Unsupported envelope version ${envelope[0]}.`);
	}
	const logN = envelope[1];
	if (logN < 10 || logN > 20) throw new DecryptError('Unreasonable scrypt cost.');
	const salt = envelope.subarray(2, 2 + SALT_LEN);
	const nonce = envelope.subarray(2 + SALT_LEN, headLen);
	const ct = envelope.subarray(headLen);
	const key = deriveKey(secret, salt, logN);
	try {
		return xchacha20poly1305(key, nonce, aad).decrypt(ct);
	} catch {
		throw new DecryptError();
	}
}
