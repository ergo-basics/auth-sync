import { describe, expect, it } from 'vitest';
import { decodeRegisters, encodeRegisters } from './codec';
import { DecryptError } from './crypto';
import { pickLatest, readRegisters } from './chain';
import { SByte, SColl } from '@fleet-sdk/serializer';
import type { ExplorerBoxLike, SyncRecord } from './types';

const rec = (id: string, data: unknown): SyncRecord => ({ id, kind: 'settings', data, updatedAt: 1 });

function toBox(id: string, h: number, regs: { R4: Uint8Array; R5: Uint8Array; R6: Uint8Array }, spent = false): ExplorerBoxLike {
	const r: any = { R4: SColl(SByte, regs.R4).toHex(), R5: SColl(SByte, regs.R5).toHex() };
	if (regs.R6.length) r.R6 = SColl(SByte, regs.R6).toHex();
	return { boxId: id, value: 1, ergoTree: '', creationHeight: h, settlementHeight: h, globalIndex: h, assets: [], additionalRegisters: r, spentTransactionId: spent ? 'x' : null };
}

describe('codec', () => {
	it('round-trips public + encrypted records', async () => {
		const regs = await encodeRegisters({
			publicRecords: [rec('pub', { a: 1 })],
			secretRecords: [rec('mn', 'word '.repeat(12))],
			secret: 'pass'
		});
		const b = await decodeRegisters(regs, 'pass');
		expect(b.publicRecords[0].data).toEqual({ a: 1 });
		expect(b.secretRecords?.[0].id).toBe('mn');
	});
	it('stays locked without secret and rejects a wrong one', async () => {
		const regs = await encodeRegisters({ secretRecords: [rec('x', 1)], secret: 'pass' });
		expect((await decodeRegisters(regs)).secretRecords).toBeNull();
		await expect(decodeRegisters(regs, 'nope')).rejects.toBeInstanceOf(DecryptError);
	});
	it('detects tampering of the public section', async () => {
		const regs = await encodeRegisters({ publicRecords: [rec('a', 1)], secretRecords: [rec('x', 1)], secret: 'p' });
		const bad = { ...regs, R5: new TextEncoder().encode('{"records":[]}') };
		await expect(decodeRegisters(bad, 'p')).rejects.toBeInstanceOf(DecryptError);
	});
	it('rejects oversized payloads and duplicate ids', async () => {
		await expect(encodeRegisters({ publicRecords: [rec('a', 'x'.repeat(4000))] })).rejects.toThrow(/limit/);
		await expect(encodeRegisters({ publicRecords: [rec('a', 1), rec('a', 2)] })).rejects.toThrow(/Duplicate/);
	});
});

describe('newest box wins', () => {
	it('picks the highest height, spent or not, ignoring foreign boxes', async () => {
		const a = await encodeRegisters({ publicRecords: [rec('v', 1)] });
		const b = await encodeRegisters({ publicRecords: [rec('v', 2)] });
		const foreign: ExplorerBoxLike = { boxId: 'f', value: 1, ergoTree: '', creationHeight: 999, assets: [], additionalRegisters: {} };
		const latest = pickLatest([toBox('old', 10, a), toBox('new', 20, b, true), foreign])!;
		expect(latest.box.boxId).toBe('new');
		expect(latest.unspent).toBe(false);
		expect(readRegisters(foreign)).toBeNull();
	});
});
