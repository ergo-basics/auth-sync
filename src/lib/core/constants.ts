// SPDX-License-Identifier: MIT

/** "ASY" + format version. R4 of every auth-sync box starts with this. */
export const MAGIC = new Uint8Array([0x41, 0x53, 0x59]); // "ASY"
export const FORMAT_VERSION = 1;
export const HEADER = new Uint8Array([...MAGIC, FORMAT_VERSION]);

/** Envelope version byte inside R6. */
export const ENVELOPE_VERSION = 1;

/**
 * Ergo limits a box to 4096 bytes in total. The ergoTree (P2PK ≈ 36 B), the
 * value, the creation height and the box overhead use some of it. We keep the
 * registers (R4-R6, plus the 58 bytes of R7) under this budget so the tx is always valid.
 */
export const MAX_REGISTER_BYTES = 3500;

/** scrypt cost (log2 N). 2^15 is ~100 ms on desktop and ~32 MiB of RAM. */
export const SCRYPT_LOG_N = 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;

export const SALT_LEN = 16;
export const NONCE_LEN = 24; // XChaCha20-Poly1305

export const DEFAULT_EXPLORER = 'https://api.ergoplatform.com';
