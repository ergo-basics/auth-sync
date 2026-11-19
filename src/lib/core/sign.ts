// SPDX-License-Identifier: MIT
// What the owner signs, so that nobody else can forge a box at the owner's address.
//
// message = "auth-sync:v1:" + hex( blake2b256(
//     "auth-sync/v1" 0x00 || len32(R4) R4 || len32(R5) R5 || len32(R6) R6
//     || u32be(creationHeight) || utf8(address) ))
//
// The signed text is printable (good for hardware wallets). The box id is not
// part of it (it is unknown before the tx exists); the creationHeight is, which
// makes a replayed copy of an old box carry its old height, so it loses.

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { concat } from './crypto';
import type { ContentRegisters } from './types';

const enc = new TextEncoder();

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const field = (b: Uint8Array) => concat(u32(b.length), b);

/** The text the owner's wallet must sign. */
export function signingMessage(r: ContentRegisters, creationHeight: number, address: string): string {
	const body = concat(
		enc.encode('auth-sync/v1'),
		new Uint8Array([0]),
		field(r.R4),
		field(r.R5),
		field(r.R6),
		u32(creationHeight),
		enc.encode(address)
	);
	return 'auth-sync:v1:' + bytesToHex(blake2b(body, { dkLen: 32 }));
}

export const messageBytes = (m: string) => enc.encode(m);
