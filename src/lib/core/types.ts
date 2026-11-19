// SPDX-License-Identifier: MIT
// Types shared by the auth-sync protocol.

/** Key → JSON value. `null` marks a key as deleted (it still shadows older boxes). */
export type Entries = Record<string, unknown>;

/** Plain content of ONE box after decoding. */
export interface BoxContent {
	/** Entries stored unencrypted in R5. */
	publicEntries: Entries;
	/** Entries stored encrypted in R6. `null` if locked (no secret given). */
	secretEntries: Entries | null;
	/** True if the box carries an encrypted section. */
	hasEncrypted: boolean;
}

/** Content registers of a box, before signing. */
export interface ContentRegisters {
	R4: Uint8Array; // header: magic + version
	R5: Uint8Array; // public entries (UTF-8 JSON object)
	R6: Uint8Array; // encrypted envelope (may be empty)
}

/** Content registers plus the owner's signature. */
export interface SyncRegisters extends ContentRegisters {
	R7: Uint8Array; // Schnorr signature (56 bytes) by the owner
}

/** Checks that `signature` signs `message` for the P2PK `address`. */
export type Verifier = (address: string, message: Uint8Array, signature: Uint8Array) => boolean | Promise<boolean>;

/** Subset of the Explorer box we rely on. */
export interface ExplorerBoxLike {
	boxId: string;
	transactionId?: string;
	value: string | number | bigint;
	ergoTree: string;
	address?: string;
	creationHeight: number;
	settlementHeight?: number;
	globalIndex?: number;
	index?: number;
	spentTransactionId?: string | null;
	assets: { tokenId: string; amount: string | number | bigint }[];
	additionalRegisters: Record<string, string | { serializedValue: string }>;
}

/** An auth-sync box found on chain. */
export interface ParsedBox {
	box: ExplorerBoxLike;
	registers: SyncRegisters;
	/** True if the box is still unspent. */
	unspent: boolean;
}

/** A spendable box as returned by wallets / Explorer (Fleet `Box`). */
export type InputBox = import('@fleet-sdk/core').Box<string | bigint>;
