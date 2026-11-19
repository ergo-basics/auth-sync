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
	signAndSubmit: async (unsigned) => {
		const signed = await ergo.sign_tx(unsigned);
		return await ergo.submit_tx(signed);
	}
};
