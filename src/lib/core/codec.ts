// SPDX-License-Identifier: MIT
// Encode / decode the register payload of an auth-sync box.
//
//   R4  Coll[Byte]  header "ASY"+version
//   R5  Coll[Byte]  UTF-8 JSON: {"records":[...]}            (unencrypted)
//   R6  Coll[Byte]  envelope (see crypto.ts) of deflate(JSON {"records":[...]})  (optional)

import { FORMAT_VERSION, HEADER, MAGIC, MAX_REGISTER_BYTES } from './constants';
import { concat, openEnvelope, sealEnvelope } from './crypto';
import type { SyncBundle, SyncRecord, SyncRegisters } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

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

function checkRecords(records: SyncRecord[]) {
	const seen = new Set<string>();
	for (const r of records) {
		if (!r.id || typeof r.id !== 'string') throw new Error('Every record needs a string id.');
		if (seen.has(r.id)) throw new Error(`Duplicate record id "${r.id}".`);
		seen.add(r.id);
	}
}

export interface EncodeParams {
	publicRecords?: SyncRecord[];
	secretRecords?: SyncRecord[];
	/** Required when secretRecords is non-empty. */
	secret?: string;
}

export async function encodeRegisters(p: EncodeParams): Promise<SyncRegisters> {
	const pub = p.publicRecords ?? [];
	const sec = p.secretRecords ?? [];
	checkRecords([...pub, ...sec]);

	const R4: Uint8Array = HEADER;
	const R5 = enc.encode(JSON.stringify({ records: pub }));
	let R6: Uint8Array = new Uint8Array(0);
	if (sec.length > 0) {
		if (!p.secret) throw new Error('A secret is required to encrypt records.');
		const plain = await deflate(enc.encode(JSON.stringify({ records: sec })));
		R6 = sealEnvelope(plain, p.secret, concat(R4, R5));
	}
	const total = R4.length + R5.length + R6.length;
	if (total > MAX_REGISTER_BYTES) {
		throw new Error(
			`Payload is ${total} bytes; the limit is ${MAX_REGISTER_BYTES} (an Ergo box holds at most 4 KB).`
		);
	}
	return { R4, R5, R6 };
}

export async function decodeRegisters(reg: SyncRegisters, secret?: string): Promise<SyncBundle> {
	if (!hasValidHeader(reg.R4)) throw new Error('Not an auth-sync box (bad magic).');
	if (reg.R4[3] !== FORMAT_VERSION) throw new Error(`Unsupported format version ${reg.R4[3]}.`);
	const publicRecords: SyncRecord[] = JSON.parse(dec.decode(reg.R5)).records ?? [];
	const hasEncrypted = reg.R6.length > 0;
	let secretRecords: SyncRecord[] | null = hasEncrypted ? null : [];
	if (hasEncrypted && secret) {
		const plain = await inflate(openEnvelope(reg.R6, secret, concat(reg.R4, reg.R5)));
		secretRecords = JSON.parse(dec.decode(plain)).records ?? [];
	}
	return { publicRecords, secretRecords, hasEncrypted };
}
