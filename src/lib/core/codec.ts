// SPDX-License-Identifier: MIT
// Encode / decode the register payload of ONE auth-sync box.
//
//   R4  Coll[Byte]  header "ASY"+version
//   R5  Coll[Byte]  UTF-8 JSON object {key: value}                 (unencrypted)
//   R6  Coll[Byte]  envelope (see crypto.ts) of deflate(JSON object)  (optional)

import { FORMAT_VERSION, HEADER, MAGIC, MAX_REGISTER_BYTES } from './constants';
import { concat, openEnvelope, sealEnvelope } from './crypto';
import type { BoxContent, Entries, SyncRegisters } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes the envelope adds to the deflated plaintext: ver+logN+salt+nonce+tag. */
const ENVELOPE_OVERHEAD = 2 + 16 + 24 + 16;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
	const w = stream.writable.getWriter();
	w.write(data as Uint8Array<ArrayBuffer>);
	w.close();
	return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
const deflate = (d: Uint8Array) => pipe(d, new CompressionStream('deflate-raw'));
const inflate = (d: Uint8Array) => pipe(d, new DecompressionStream('deflate-raw'));

export function hasValidHeader(r4: Uint8Array | undefined): boolean {
	return !!r4 && r4.length >= 4 && MAGIC.every((b, i) => r4[i] === b);
}

function checkEntries(pub: Entries, sec: Entries) {
	for (const k of Object.keys(sec)) {
		if (k in pub) throw new Error(`Key "${k}" is both public and secret.`);
	}
}

export interface EncodeParams {
	publicEntries?: Entries;
	secretEntries?: Entries;
	/** Required when secretEntries is non-empty. */
	secret?: string;
}

export async function encodeRegisters(p: EncodeParams): Promise<SyncRegisters> {
	const pub = p.publicEntries ?? {};
	const sec = p.secretEntries ?? {};
	checkEntries(pub, sec);

	const R4: Uint8Array = HEADER;
	const R5 = enc.encode(JSON.stringify(pub));
	let R6: Uint8Array = new Uint8Array(0);
	if (Object.keys(sec).length > 0) {
		if (!p.secret) throw new Error('A secret is required to encrypt entries.');
		const plain = await deflate(enc.encode(JSON.stringify(sec)));
		R6 = sealEnvelope(plain, p.secret, concat(R4, R5));
	}
	const total = R4.length + R5.length + R6.length;
	if (total > MAX_REGISTER_BYTES) {
		throw new Error(`Payload is ${total} bytes; the limit per box is ${MAX_REGISTER_BYTES}.`);
	}
	return { R4, R5, R6 };
}

export async function decodeRegisters(reg: SyncRegisters, secret?: string): Promise<BoxContent> {
	if (!hasValidHeader(reg.R4)) throw new Error('Not an auth-sync box (bad magic).');
	if (reg.R4[3] !== FORMAT_VERSION) throw new Error(`Unsupported format version ${reg.R4[3]}.`);
	const publicEntries: Entries = JSON.parse(dec.decode(reg.R5));
	const hasEncrypted = reg.R6.length > 0;
	let secretEntries: Entries | null = hasEncrypted ? null : {};
	if (hasEncrypted && secret) {
		const plain = await inflate(openEnvelope(reg.R6, secret, concat(reg.R4, reg.R5)));
		secretEntries = JSON.parse(dec.decode(plain));
	}
	return { publicEntries, secretEntries, hasEncrypted };
}

/** Estimated register bytes for a box holding these entries (no encryption run). */
async function estimate(pub: Entries, sec: Entries): Promise<number> {
	let n = HEADER.length + enc.encode(JSON.stringify(pub)).length;
	if (Object.keys(sec).length > 0) {
		n += ENVELOPE_OVERHEAD + (await deflate(enc.encode(JSON.stringify(sec)))).length;
	}
	return n;
}

export interface Chunk {
	publicEntries: Entries;
	secretEntries: Entries;
}

/**
 * Split entries into groups that each fit in one box. Greedy, in insertion
 * order (public first). Keys never repeat across chunks, so the order of the
 * resulting boxes does not matter.
 */
export async function splitEntries(pub: Entries, sec: Entries): Promise<Chunk[]> {
	checkEntries(pub, sec);
	const chunks: Chunk[] = [];
	let cur: Chunk = { publicEntries: {}, secretEntries: {} };
	const add = async (k: string, v: unknown, secret: boolean) => {
		const tryChunk: Chunk = {
			publicEntries: secret ? cur.publicEntries : { ...cur.publicEntries, [k]: v },
			secretEntries: secret ? { ...cur.secretEntries, [k]: v } : cur.secretEntries
		};
		if ((await estimate(tryChunk.publicEntries, tryChunk.secretEntries)) <= MAX_REGISTER_BYTES) {
			cur = tryChunk;
			return;
		}
		if (Object.keys(cur.publicEntries).length + Object.keys(cur.secretEntries).length === 0) {
			throw new Error(`Entry "${k}" alone does not fit in one box (${MAX_REGISTER_BYTES} bytes).`);
		}
		chunks.push(cur);
		cur = { publicEntries: {}, secretEntries: {} };
		await add(k, v, secret);
	};
	for (const [k, v] of Object.entries(pub)) await add(k, v, false);
	for (const [k, v] of Object.entries(sec)) await add(k, v, true);
	if (Object.keys(cur.publicEntries).length + Object.keys(cur.secretEntries).length > 0) chunks.push(cur);
	return chunks;
}
