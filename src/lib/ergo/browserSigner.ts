// SPDX-License-Identifier: MIT
// Signer backed by the injected EIP-12 `ergo` connector (Nautilus, SAFEW...).
// With a cold/hardware wallet behind the connector, only the upload tx needs it.

import type { InputBox } from '$lib/core/types';
import type { Signer } from '$lib/core/authSync';

declare const ergo: any;

export const browserSigner: Signer = {
	address: async () => await ergo.get_change_address(),
	height: async () => await ergo.get_current_height(),
	utxos: async () => (await ergo.get_utxos()) as InputBox[],
	// EIP-12 `auth` signs a text message with the P2PK key of the address and
	// returns a proof. NOTE: the exact proof encoding differs by wallet; this
	// accepts a hex string, or an object with a `proof` hex field.
	signMessage: async (address, message) => {
		const r = await ergo.auth(address, message);
		const proof = typeof r === 'string' ? r : (r?.proof ?? r?.signedMessage?.proof);
		if (typeof proof !== 'string') throw new Error('The wallet did not return a signature proof.');
		return Uint8Array.from(proof.match(/../g)!.map((h) => parseInt(h, 16)));
	},
	signAndSubmit: async (unsigned) => {
		const signed = await ergo.sign_tx(unsigned);
		return await ergo.submit_tx(signed);
	}
};
