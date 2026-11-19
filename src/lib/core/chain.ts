// SPDX-License-Identifier: MIT
// Explorer reads + transaction building. No Svelte, no wallet globals, so the
// MCP bundle can reuse this file as-is.

import {
	OutputBuilder,
	RECOMMENDED_MIN_FEE_VALUE,
	SAFE_MIN_BOX_VALUE,
	TransactionBuilder,
} from '@fleet-sdk/core';
import { SByte, SColl, SConstant } from '@fleet-sdk/serializer';
import { DEFAULT_EXPLORER } from './constants';
import { hasValidHeader } from './codec';
import type { ExplorerBoxLike, InputBox, LatestBox, SyncRegisters } from './types';

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

/** Parse the auth-sync registers of a box, or `null` if it is not one. */
export function readRegisters(box: ExplorerBoxLike): SyncRegisters | null {
	const R4 = regBytes(box, 'R4');
	if (!hasValidHeader(R4)) return null;
	const R5 = regBytes(box, 'R5');
	if (!R5) return null;
	return { R4: R4!, R5, R6: regBytes(box, 'R6') ?? new Uint8Array(0) };
}

// ---------- the "newest box wins" rule ----------

/** Order boxes by when they entered the chain. Higher = newer. */
function age(b: ExplorerBoxLike): [number, number] {
	return [b.settlementHeight ?? b.creationHeight, b.globalIndex ?? 0];
}
export function isNewer(a: ExplorerBoxLike, b: ExplorerBoxLike): boolean {
	const [ah, ai] = age(a);
	const [bh, bi] = age(b);
	return ah !== bh ? ah > bh : ai > bi;
}

/**
 * Pick the winning box from a list: the newest valid auth-sync box.
 * Spent boxes count too — an ordinary wallet transaction can spend the box
 * without meaning to delete the data, so the newest one is still the truth.
 */
export function pickLatest(boxes: ExplorerBoxLike[]): LatestBox | null {
	let best: LatestBox | null = null;
	for (const box of boxes) {
		const registers = readRegisters(box);
		if (!registers) continue;
		if (!best || isNewer(box, best.box)) best = { box, registers, unspent: !box.spentTransactionId };
	}
	return best;
}

export async function fetchLatestBox(
	address: string,
	explorer: string = DEFAULT_EXPLORER,
	opts: { maxPages?: number; fetchImpl?: typeof fetch } = {}
): Promise<LatestBox | null> {
	const f = opts.fetchImpl ?? fetch;
	const limit = 100;
	const maxPages = opts.maxPages ?? 50;
	const all: ExplorerBoxLike[] = [];
	for (let page = 0; page < maxPages; page++) {
		const url = `${explorer}/api/v1/boxes/byAddress/${address}?limit=${limit}&offset=${page * limit}&sortDirection=desc`;
		const res = await f(url);
		if (!res.ok) throw new Error(`Explorer ${res.status} for ${url}`);
		const { items = [], total = 0 } = await res.json();
		all.push(...items);
		if ((page + 1) * limit >= total || items.length === 0) break;
	}
	return pickLatest(all);
}

// ---------- transaction building ----------

export interface BuildSyncTxParams {
	/** The user's own address; the data box is locked to it (no contract). */
	address: string;
	/** Spendable boxes of that address (wallet UTXOs). */
	inputs: InputBox[];
	height: number;
	registers: SyncRegisters;
	/** Previous data box, if still unspent: it is spent so its ERG is reclaimed. */
	previous?: InputBox;
	fee?: bigint;
}

export function buildSyncTx(p: BuildSyncTxParams) {
	const out = new OutputBuilder(SAFE_MIN_BOX_VALUE, p.address);
	const regs: Record<string, string> = {
		R4: SColl(SByte, p.registers.R4).toHex(),
		R5: SColl(SByte, p.registers.R5).toHex()
	};
	if (p.registers.R6.length > 0) regs.R6 = SColl(SByte, p.registers.R6).toHex();
	out.setAdditionalRegisters(regs);

	const b = new TransactionBuilder(p.height).from(p.inputs);
	if (p.previous) {
		const prevId = p.previous.boxId;
		b.configureSelector((s) => s.ensureInclusion(prevId));
	}
	return b
		.to(out)
		.sendChangeTo(p.address)
		.payFee(p.fee ?? RECOMMENDED_MIN_FEE_VALUE)
		.build();
}
