// SPDX-License-Identifier: MIT
// Explorer reads, the merge rule and transaction building. No Svelte, no wallet
// globals, so the MCP bundle can reuse this file as-is.

import {
	BOX_VALUE_PER_BYTE,
	OutputBuilder,
	RECOMMENDED_MIN_FEE_VALUE,
	SAFE_MIN_BOX_VALUE,
	TransactionBuilder
} from '@fleet-sdk/core';
import { SByte, SColl, SConstant } from '@fleet-sdk/serializer';
import { DEFAULT_EXPLORER } from './constants';
import { decodeRegisters, hasValidHeader } from './codec';
import { messageBytes, signingMessage } from './sign';
import type { Entries, ExplorerBoxLike, InputBox, ParsedBox, SyncRegisters, Verifier } from './types';

// ---------- register helpers ----------

function regHex(box: ExplorerBoxLike, key: string): string | undefined {
	const v = box.additionalRegisters?.[key];
	return typeof v === 'string' ? v : v?.serializedValue;
}

function regBytes(box: ExplorerBoxLike, key: string): Uint8Array | undefined {
	const hex = regHex(box, key);
	if (!hex) return undefined;
	try {
		const data = SConstant.from(hex).data;
		return data instanceof Uint8Array ? data : Uint8Array.from(data as number[]);
	} catch {
		return undefined; // register holds some other type: not ours
	}
}

/** Parse the auth-sync registers of a box (R4-R7), or `null` if it is not one. */
export function readRegisters(box: ExplorerBoxLike): SyncRegisters | null {
	const R4 = regBytes(box, 'R4');
	if (!hasValidHeader(R4)) return null;
	const R5 = regBytes(box, 'R5');
	const R7 = regBytes(box, 'R7');
	if (!R5 || !R7) return null;
	return { R4: R4!, R5, R6: regBytes(box, 'R6') ?? new Uint8Array(0), R7 };
}

// ---------- reading ----------

/**
 * Keep only boxes of this address that carry a valid owner signature.
 * Anyone can send a box to any address, so an unsigned or badly signed box
 * is ignored, exactly like a box of another application.
 */
export async function parseBoxes(
	boxes: ExplorerBoxLike[],
	address: string,
	verify: Verifier
): Promise<ParsedBox[]> {
	const out: ParsedBox[] = [];
	for (const box of boxes) {
		const registers = readRegisters(box);
		if (!registers) continue;
		const msg = messageBytes(signingMessage(registers, box.creationHeight, address));
		let ok = false;
		try {
			ok = await verify(address, msg, registers.R7);
		} catch {
			ok = false;
		}
		if (ok) out.push({ box, registers, unspent: !box.spentTransactionId });
	}
	return out;
}

/** All valid auth-sync boxes of an address, spent or not. */
export async function fetchBoxes(
	address: string,
	verify: Verifier,
	explorer: string = DEFAULT_EXPLORER,
	opts: { maxPages?: number; fetchImpl?: typeof fetch } = {}
): Promise<ParsedBox[]> {
	const f = opts.fetchImpl ?? fetch;
	const limit = 100;
	const all: ExplorerBoxLike[] = [];
	for (let page = 0; page < (opts.maxPages ?? 50); page++) {
		const url = `${explorer}/api/v1/boxes/byAddress/${address}?limit=${limit}&offset=${page * limit}`;
		const res = await f(url);
		if (!res.ok) throw new Error(`Explorer ${res.status} for ${url}`);
		const { items = [], total = 0 } = await res.json();
		all.push(...items);
		if ((page + 1) * limit >= total || items.length === 0) break;
	}
	return parseBoxes(all, address, verify);
}

// ---------- the merge rule ----------
//
// Many boxes may exist. For each key, the value from the box with the HIGHEST
// creationHeight wins. creationHeight is covered by the owner's signature, so
// nobody else can choose it. Boxes with the same creationHeight are equally
// valid; we order them by globalIndex only so every reader gets the same answer.

function age(b: ExplorerBoxLike): [number, number] {
	return [b.creationHeight, b.globalIndex ?? 0];
}
/** True if `a` wins over `b`. */
export function isNewer(a: ExplorerBoxLike, b: ExplorerBoxLike): boolean {
	const [ah, ai] = age(a);
	const [bh, bi] = age(b);
	return ah !== bh ? ah > bh : ai > bi;
}

export interface Merged {
	/** Final key → value view (deleted keys removed). */
	entries: Entries;
	/** Key → boxId of the box that supplied the value. */
	sources: Record<string, string>;
	/** Boxes with encrypted data that could not be opened (no/wrong secret). */
	lockedBoxes: string[];
	/** Unspent boxes whose every key is shadowed by a newer box: safe to spend. */
	reclaimable: ParsedBox[];
}

export async function mergeBoxes(boxes: ParsedBox[], secret?: string): Promise<Merged> {
	const sorted = [...boxes].sort((a, b) => (isNewer(a.box, b.box) ? 1 : -1)); // oldest first
	const winner: Record<string, { value: unknown; boxId: string }> = {};
	const keysOf = new Map<string, string[]>();
	const lockedBoxes: string[] = [];

	for (const pb of sorted) {
		const c = await decodeRegisters(pb.registers, secret);
		if (c.secretEntries === null) lockedBoxes.push(pb.box.boxId);
		const e = { ...c.publicEntries, ...(c.secretEntries ?? {}) };
		keysOf.set(pb.box.boxId, Object.keys(e));
		for (const [k, v] of Object.entries(e)) winner[k] = { value: v, boxId: pb.box.boxId }; // newer overwrites
	}

	const entries: Entries = {};
	const sources: Record<string, string> = {};
	for (const [k, w] of Object.entries(winner)) {
		sources[k] = w.boxId;
		if (w.value !== null) entries[k] = w.value;
	}
	const reclaimable = sorted.filter(
		(pb) =>
			pb.unspent &&
			!lockedBoxes.includes(pb.box.boxId) &&
			keysOf.get(pb.box.boxId)!.every((k) => sources[k] !== pb.box.boxId)
	);
	return { entries, sources, lockedBoxes, reclaimable };
}

// ---------- transaction building ----------

export interface BuildSyncTxParams {
	/** The user's own address; every data box is locked to it (no contract). */
	address: string;
	/** Spendable boxes of that address (wallet UTXOs). */
	inputs: InputBox[];
	height: number;
	/** One entry per output box, already signed (R7). */
	registers: SyncRegisters[];
	/** Obsolete data boxes to spend so their ERG is reclaimed. */
	reclaim?: InputBox[];
	fee?: bigint;
}

export function buildSyncTx(p: BuildSyncTxParams) {
	const outputs = p.registers.map((r) => {
		const out = new OutputBuilder(SAFE_MIN_BOX_VALUE, p.address);
		const regs: Record<string, string> = {
			R4: SColl(SByte, r.R4).toHex(),
			R5: SColl(SByte, r.R5).toHex()
		};
		// Registers must be dense: R7 needs R6, so an empty R6 is still written.
		regs.R6 = SColl(SByte, r.R6).toHex();
		regs.R7 = SColl(SByte, r.R7).toHex();
		out.setAdditionalRegisters(regs).setCreationHeight(p.height);
		// Big payloads need more than the safe minimum (360 nanoERG per byte).
		const need = BigInt(out.estimateSize()) * BOX_VALUE_PER_BYTE;
		return need > SAFE_MIN_BOX_VALUE ? out.setValue(need) : out;
	});

	const reclaim = p.reclaim ?? [];
	const ids = new Set(reclaim.map((b) => b.boxId));
	const rest = p.inputs.filter((b) => !ids.has(b.boxId));
	return new TransactionBuilder(p.height)
		.from([...reclaim, ...rest])
		.configureSelector((s) => s.ensureInclusion(reclaim.map((b) => b.boxId)))
		.to(outputs)
		.sendChangeTo(p.address)
		.payFee(p.fee ?? RECOMMENDED_MIN_FEE_VALUE)
		.build();
}
