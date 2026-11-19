import { describe, expect, it } from 'vitest';
import { decodeRegisters, encodeRegisters, splitEntries } from './codec';
import { DecryptError } from './crypto';
import { mergeBoxes, parseBoxes, readRegisters } from './chain';
import { signingMessage } from './sign';
import { nodeVerifier, secretMessageSigner } from './verify-node';
import { SByte, SColl } from '@fleet-sdk/serializer';
import type { Entries, ExplorerBoxLike } from './types';

const owner = secretMessageSigner(new Uint8Array(32).fill(7));
const attacker = secretMessageSigner(new Uint8Array(32).fill(9));
const ADDR = owner.address;

/** Build an Explorer-like box at ADDR. `by` is who signed R7 (default: the owner). */
async function box(id: string, h: number, pub: Entries, sec: Entries = {}, o: { spent?: boolean; idx?: number; secret?: string; by?: typeof owner; sigHeight?: number } = {}): Promise<ExplorerBoxLike> {
	const regs = await encodeRegisters({ publicEntries: pub, secretEntries: sec, secret: o.secret });
	const by = o.by ?? owner; // an attacker can only sign with their own key/address
	const R7 = by.sign(by.address, signingMessage(regs, o.sigHeight ?? h, ADDR));
	const r: any = {
		R4: SColl(SByte, regs.R4).toHex(), R5: SColl(SByte, regs.R5).toHex(),
		R6: SColl(SByte, regs.R6).toHex(), R7: SColl(SByte, R7).toHex()
	};
	return { boxId: id, value: 1, ergoTree: '', creationHeight: h, globalIndex: o.idx ?? h, assets: [], additionalRegisters: r, spentTransactionId: o.spent ? 'x' : null };
}
const parse = (b: ExplorerBoxLike[]) => parseBoxes(b, ADDR, nodeVerifier);

describe('codec', () => {
	it('R5 is a plain JSON object and round-trips with encrypted entries', async () => {
		const regs = await encodeRegisters({ publicEntries: { a: 1 }, secretEntries: { mn: 'word '.repeat(12) }, secret: 'pass' });
		expect(JSON.parse(new TextDecoder().decode(regs.R5))).toEqual({ a: 1 });
		const b = await decodeRegisters(regs, 'pass');
		expect(b.publicEntries).toEqual({ a: 1 });
		expect(b.secretEntries?.mn).toContain('word');
	});
	it('stays locked without secret and rejects a wrong one', async () => {
		const regs = await encodeRegisters({ secretEntries: { x: 1 }, secret: 'pass' });
		expect((await decodeRegisters(regs)).secretEntries).toBeNull();
		await expect(decodeRegisters(regs, 'nope')).rejects.toBeInstanceOf(DecryptError);
	});
	it('detects tampering of the public section', async () => {
		const regs = await encodeRegisters({ publicEntries: { a: 1 }, secretEntries: { x: 1 }, secret: 'p' });
		await expect(decodeRegisters({ ...regs, R5: new TextEncoder().encode('{}') }, 'p')).rejects.toBeInstanceOf(DecryptError);
	});
	it('rejects an oversized box and a key that is both public and secret', async () => {
		await expect(encodeRegisters({ publicEntries: { a: 'x'.repeat(4000) } })).rejects.toThrow(/limit/);
		await expect(encodeRegisters({ publicEntries: { a: 1 }, secretEntries: { a: 2 }, secret: 's' })).rejects.toThrow(/both/);
	});
});

describe('splitEntries', () => {
	it('keeps small data in one box and splits big data without losing keys', async () => {
		expect(await splitEntries({ a: 1 }, { b: 2 })).toHaveLength(1);
		const big: Entries = {};
		for (let i = 0; i < 8; i++) big['k' + i] = 'x'.repeat(900) + i;
		const chunks = await splitEntries(big, {});
		expect(chunks.length).toBeGreaterThan(1);
		expect(Object.assign({}, ...chunks.map((c) => c.publicEntries))).toEqual(big);
		for (const c of chunks) await encodeRegisters(c); // each one fits
	});
	it('throws when one entry cannot fit', async () => {
		await expect(splitEntries({ a: 'x'.repeat(5000) }, {})).rejects.toThrow(/alone/);
	});
});

describe('merge: highest creationHeight wins per key', () => {
	it('merges keys from several boxes and the higher creationHeight overrides', async () => {
		const boxes = await parse([
			await box('old', 10, { theme: 'dark', lang: 'es' }),
			await box('new', 20, { theme: 'light' }),
			{ boxId: 'foreign', value: 1, ergoTree: '', creationHeight: 999, assets: [], additionalRegisters: {} }
		]);
		const m = await mergeBoxes(boxes);
		expect(m.entries).toEqual({ theme: 'light', lang: 'es' });
		expect(m.sources).toEqual({ theme: 'new', lang: 'old' });
		expect(readRegisters(boxes[0].box)).not.toBeNull();
	});
	it('same block: either is valid, and the result is deterministic', async () => {
		const a = await box('a', 10, { k: 'A' }, {}, { idx: 1 });
		const b = await box('b', 10, { k: 'B' }, {}, { idx: 2 });
		const m1 = await mergeBoxes(await parse([a, b]));
		const m2 = await mergeBoxes(await parse([b, a]));
		expect(['A', 'B']).toContain(m1.entries.k);
		expect(m1.entries).toEqual(m2.entries);
	});
	it('null deletes a key; spent boxes still count', async () => {
		const m = await mergeBoxes(await parse([
			await box('old', 10, { a: 1, b: 2 }, {}, { spent: true }),
			await box('new', 20, { a: null })
		]));
		expect(m.entries).toEqual({ b: 2 });
	});
	it('merges encrypted entries and flags locked boxes without the secret', async () => {
		const boxes = await parse([await box('p', 10, { a: 1 }), await box('s', 20, {}, { w: 'seed' }, { secret: 'pw' })]);
		expect((await mergeBoxes(boxes, 'pw')).entries).toEqual({ a: 1, w: 'seed' });
		const locked = await mergeBoxes(boxes);
		expect(locked.entries).toEqual({ a: 1 });
		expect(locked.lockedBoxes).toEqual(['s']);
	});
	it('lists fully shadowed unspent boxes as reclaimable', async () => {
		const m = await mergeBoxes(await parse([
			await box('old', 10, { a: 1 }),
			await box('keep', 15, { b: 1 }),
			await box('new', 20, { a: 2 })
		]));
		expect(m.reclaimable.map((b) => b.box.boxId)).toEqual(['old']);
	});
});

describe('owner signature (R7)', () => {
	it('ignores boxes signed by someone else, or without a signature', async () => {
		const good = await box('good', 10, { a: 1 });
		const forged = await box('forged', 99, { a: 'EVIL' }, {}, { by: attacker });
		const unsigned = await box('unsigned', 98, { a: 'EVIL2' });
		delete (unsigned.additionalRegisters as any).R7;
		const m = await mergeBoxes(await parse([good, forged, unsigned]));
		expect(m.entries).toEqual({ a: 1 });
	});
	it('rejects a box whose content or creationHeight differs from what was signed', async () => {
		const good = await box('g', 10, { a: 1 });
		const moved = { ...good, boxId: 'm', creationHeight: 50 }; // replay with a higher height
		const tampered = await box('t', 20, { a: 'x' }, {}, { sigHeight: 5 });
		expect((await parse([moved, tampered])).length).toBe(0);
	});
	it('a replayed copy cannot override newer data', async () => {
		const old = await box('old', 10, { v: 'old' });
		const fresh = await box('fresh', 20, { v: 'new' });
		const copy = { ...old, boxId: 'copy', globalIndex: 9999 }; // same registers, same creationHeight, later on chain
		const m = await mergeBoxes(await parse([old, fresh, copy]));
		expect(m.entries).toEqual({ v: 'new' });
	});
	it('a signature for another address is not valid here', async () => {
		const other = attacker.address;
		const regs = await encodeRegisters({ publicEntries: { a: 1 } });
		const R7 = attacker.sign(other, signingMessage(regs, 10, other));
		const b = await box('x', 10, { a: 1 });
		(b.additionalRegisters as any).R7 = SColl(SByte, R7).toHex();
		expect((await parse([b])).length).toBe(0);
	});
});

import { buildSyncTx } from './chain';
import { MockChain } from '@fleet-sdk/mock-chain';

describe('buildSyncTx', () => {
	it('creates one output per register set and spends the reclaimed box', async () => {
		const chain = new MockChain({ height: 100 });
		const party = chain.newParty('user');
		party.addBalance({ nanoergs: 10_000_000_000n });
		party.addBalance({ nanoergs: 2_000_000n });
		const [a, b] = party.utxos.toArray();
		const r1 = { ...(await encodeRegisters({ publicEntries: { a: 1 } })), R7: new Uint8Array(56) };
		const r2 = { ...(await encodeRegisters({ publicEntries: { b: 2 } })), R7: new Uint8Array(56) };
		const tx = buildSyncTx({ address: party.address.encode(), inputs: [a, b], height: 100, registers: [r1, r2], reclaim: [b] }).toEIP12Object();
		expect(tx.inputs.map((i: any) => i.boxId)).toContain(b.boxId);
		expect(tx.outputs.filter((o: any) => o.additionalRegisters.R7)).toHaveLength(2);
	});
});
