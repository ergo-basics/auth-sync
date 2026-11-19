// SPDX-License-Identifier: MIT
// Types shared by the auth-sync protocol.

/** One logical item stored in the auth-sync box. */
export interface SyncRecord {
	/** Unique id inside the box (e.g. "chatui/settings", "wallet/ergo"). */
	id: string;
	/** Free-form category: "settings", "mnemonic", "app-config", "data"... */
	kind: string;
	/** JSON-serialisable value. */
	data: unknown;
	/** Unix ms, set by the writer. */
	updatedAt: number;
}

/** Plain content of a box after decoding. */
export interface SyncBundle {
	/** Records stored unencrypted in R5. */
	publicRecords: SyncRecord[];
	/** Records stored encrypted in R6. `null` if locked (no secret given). */
	secretRecords: SyncRecord[] | null;
	/** True if the box carries an encrypted section. */
	hasEncrypted: boolean;
}

/** Raw register contents as bytes. */
export interface SyncRegisters {
	R4: Uint8Array; // header: magic + version
	R5: Uint8Array; // public records (UTF-8 JSON)
	R6: Uint8Array; // encrypted envelope (may be empty)
}

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

export interface LatestBox {
	box: ExplorerBoxLike;
	registers: SyncRegisters;
	/** True if the box is still unspent. */
	unspent: boolean;
}

/** A spendable box as returned by wallets / Explorer (Fleet `Box`). */
export type InputBox = import('@fleet-sdk/core').Box<string | bigint>;
