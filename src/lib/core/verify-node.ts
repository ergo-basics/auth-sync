// SPDX-License-Identifier: MIT
// Node-only: verifier (and a test/seed signer helper) on top of ergo-lib-wasm.
// Not exported from index.ts, so the browser bundle never pulls it in.

import * as wasm from 'ergo-lib-wasm-nodejs';
import type { Verifier } from './types';

export const nodeVerifier: Verifier = (address, message, signature) =>
	wasm.verify_signature(wasm.Address.from_base58(address), message, signature);

/** Signs messages with a BIP-39 mnemonic (first address). For seed signers and tests. */
export function mnemonicMessageSigner(mnemonic: string, pass = '') {
	const wallet = wasm.Wallet.from_mnemonic(mnemonic, pass);
	return (address: string, message: string) =>
		wallet.sign_message_using_p2pk(wasm.Address.from_base58(address), new TextEncoder().encode(message));
}

/** Signs with a raw 32-byte dlog secret. Handy for tests. */
export function secretMessageSigner(secret: Uint8Array) {
	const sk = wasm.SecretKey.dlog_from_bytes(secret);
	const keys = new wasm.SecretKeys();
	keys.add(sk);
	const wallet = wasm.Wallet.from_secrets(keys);
	const address = sk.get_address().to_base58(wasm.NetworkPrefix.Mainnet);
	return {
		address,
		sign: (addr: string, message: string) =>
			wallet.sign_message_using_p2pk(wasm.Address.from_base58(addr), new TextEncoder().encode(message))
	};
}
