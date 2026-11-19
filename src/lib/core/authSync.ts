// SPDX-License-Identifier: MIT
// High-level API. A `Signer` abstracts how a tx gets signed (browser wallet,
// seed phrase on a server, or "just give me the unsigned tx").

import { buildSyncTx, fetchLatestBox } from './chain';
import { decodeRegisters, encodeRegisters } from './codec';
import { DEFAULT_EXPLORER } from './constants';
import type { InputBox, SyncBundle, SyncRecord } from './types';

export interface Signer {
	address(): Promise<string>;
	height(): Promise<number>;
	utxos(): Promise<InputBox[]>;
	/** Sign + submit. Return the tx id, or `null` for build-only signers. */
	signAndSubmit(unsignedEip12: unknown): Promise<string | null>;
}

export interface PushParams {
	publicRecords?: SyncRecord[];
	secretRecords?: SyncRecord[];
	secret?: string;
}

export interface PushResult {
	txId: string | null;
	/** EIP-12 unsigned tx; useful for build-only signers. */
	unsigned: unknown;
}

export class AuthSync {
	constructor(
		private signer: Signer,
		private explorer: string = DEFAULT_EXPLORER
	) {}

	/** Newest box of this address, decoded. `null` if the user never pushed. */
	async pull(secret?: string, address?: string): Promise<SyncBundle | null> {
		const addr = address ?? (await this.signer.address());
		const latest = await fetchLatestBox(addr, this.explorer);
		return latest ? decodeRegisters(latest.registers, secret) : null;
	}

	/** Replace the stored state with a new box (the old one is spent if unspent). */
	async push(p: PushParams): Promise<PushResult> {
		const address = await this.signer.address();
		const registers = await encodeRegisters(p);
		const [inputs, height, latest] = await Promise.all([
			this.signer.utxos(),
			this.signer.height(),
			fetchLatestBox(address, this.explorer)
		]);
		const previous = latest?.unspent ? (latest.box as unknown as InputBox) : undefined;
		const tx = buildSyncTx({ address, inputs, height, registers, previous });
		const unsigned = tx.toEIP12Object();
		return { txId: await this.signer.signAndSubmit(unsigned), unsigned };
	}
}
