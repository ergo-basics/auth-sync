// SPDX-License-Identifier: MIT
// High-level API. A `Signer` abstracts how things get signed (browser wallet,
// seed phrase on a server, or "just give me the unsigned tx").

import { buildSyncTx, fetchBoxes, mergeBoxes, type Merged } from './chain';
import { decodeRegisters, encodeRegisters, splitEntries } from './codec';
import { DEFAULT_EXPLORER } from './constants';
import { signingMessage } from './sign';
import type { Entries, InputBox, SyncRegisters, Verifier } from './types';

export interface Signer {
	address(): Promise<string>;
	height(): Promise<number>;
	utxos(): Promise<InputBox[]>;
	/**
	 * Sign a text message with the P2PK key of `address` (EIP-12 `auth`).
	 * Returns the 56-byte Schnorr signature. One prompt per call.
	 */
	signMessage(address: string, message: string): Promise<Uint8Array>;
	/** Sign + submit. Return the tx id, or `null` for build-only signers. */
	signAndSubmit(unsignedEip12: unknown): Promise<string | null>;
}

export interface PushParams {
	/** Entries to write unencrypted. A `null` value deletes the key. */
	publicEntries?: Entries;
	/** Entries to write encrypted. A `null` value deletes the key. */
	secretEntries?: Entries;
	secret?: string;
	/** Also spend older boxes that this push fully replaces (default true). */
	reclaim?: boolean;
}

export interface PushResult {
	txId: string | null;
	/** EIP-12 unsigned tx; useful for build-only signers. */
	unsigned: unknown;
	/** Number of new boxes created. */
	boxes: number;
}

export class AuthSync {
	constructor(
		private signer: Signer,
		private verify: Verifier,
		private explorer: string = DEFAULT_EXPLORER
	) {}

	/** Merged view of every valid auth-sync box of the address. */
	async pull(secret?: string, address?: string): Promise<Merged> {
		const addr = address ?? (await this.signer.address());
		return mergeBoxes(await fetchBoxes(addr, this.verify, this.explorer), secret);
	}

	/**
	 * Write the given entries in new box(es). Other keys are untouched. If the
	 * entries do not fit in one box they are split over several outputs of one tx.
	 * Each new box needs one signature from the wallet, plus the tx signature.
	 */
	async push(p: PushParams): Promise<PushResult> {
		const address = await this.signer.address();
		const chunks = await splitEntries(p.publicEntries ?? {}, p.secretEntries ?? {});
		if (chunks.length === 0) throw new Error('Nothing to push.');
		const content = await Promise.all(chunks.map((c) => encodeRegisters({ ...c, secret: p.secret })));

		const [inputs, height, existing] = await Promise.all([
			this.signer.utxos(),
			this.signer.height(),
			fetchBoxes(address, this.verify, this.explorer)
		]);

		const registers: SyncRegisters[] = [];
		for (const r of content) {
			const R7 = await this.signer.signMessage(address, signingMessage(r, height, address));
			registers.push({ ...r, R7 });
		}

		let reclaim: InputBox[] = [];
		if (p.reclaim !== false) {
			const fresh = { ...(p.publicEntries ?? {}), ...(p.secretEntries ?? {}) };
			reclaim = await this.reclaimable(existing, fresh, p.secret);
		}
		const tx = buildSyncTx({ address, inputs, height, registers, reclaim });
		const unsigned = tx.toEIP12Object();
		return { txId: await this.signer.signAndSubmit(unsigned), unsigned, boxes: registers.length };
	}

	/** Unspent readable boxes whose keys are all replaced by `fresh` or by newer boxes. */
	private async reclaimable(
		existing: Awaited<ReturnType<typeof fetchBoxes>>,
		fresh: Entries,
		secret?: string
	): Promise<InputBox[]> {
		const merged = await mergeBoxes(existing, secret);
		const out: InputBox[] = [];
		for (const pb of existing) {
			if (!pb.unspent || merged.lockedBoxes.includes(pb.box.boxId)) continue;
			const c = await decodeRegisters(pb.registers, secret);
			const keys = Object.keys({ ...c.publicEntries, ...(c.secretEntries ?? {}) });
			if (keys.every((k) => k in fresh || merged.sources[k] !== pb.box.boxId)) {
				out.push(pb.box as unknown as InputBox);
			}
		}
		return out;
	}
}
