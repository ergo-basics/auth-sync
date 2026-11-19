// SPDX-License-Identifier: MIT
// Verifier for the browser, using the WASM build of ergo-lib (loaded on first use).

import type { Verifier } from '$lib/core/types';

let lib: Promise<typeof import('ergo-lib-wasm-browser')> | undefined;

export const browserVerifier: Verifier = async (address, message, signature) => {
	lib ??= import('ergo-lib-wasm-browser');
	const wasm = await lib;
	return wasm.verify_signature(wasm.Address.from_base58(address), message, signature);
};
