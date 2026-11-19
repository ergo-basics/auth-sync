// Single registry of tools; used by the stdio server and the .service HTTP server.
import { z } from 'zod';
import * as lib from './_generated/lib.bundle.mjs';
import { OutputBuilder } from '@fleet-sdk/core';

const EXPLORER = process.env.APP_EXPLORER_API || lib.DEFAULT_EXPLORER;
const SECRET = process.env.AUTHSYNC_SECRET; // optional default secret for decrypt/encrypt

/** Build-only signer: needs the caller's address + utxos; never signs. */
async function explorerUtxos(address) {
  const r = await fetch(`${EXPLORER}/api/v1/boxes/unspent/byAddress/${address}?limit=100`);
  if (!r.ok) throw new Error(`Explorer ${r.status}`);
  return (await r.json()).items.map((b) => ({ ...b, additionalRegisters: Object.fromEntries(Object.entries(b.additionalRegisters).map(([k, v]) => [k, v.serializedValue ?? v])) }));
}
async function height() {
  const r = await fetch(`${EXPLORER}/api/v1/networkState`);
  return (await r.json()).height;
}

const record = z.object({ id: z.string(), kind: z.string(), data: z.any() });

export const TOOLS = {
  authsync_pull: {
    description: 'Read the newest auth-sync box of an address. Pass `secret` (or set AUTHSYNC_SECRET) to decrypt the encrypted records.',
    schema: { address: z.string(), secret: z.string().optional() },
    async handler({ address, secret }) {
      const latest = await lib.fetchLatestBox(address, EXPLORER);
      if (!latest) return { found: false };
      const bundle = await lib.decodeRegisters(latest.registers, secret ?? SECRET);
      return { found: true, boxId: latest.box.boxId, unspent: latest.unspent, ...bundle };
    }
  },
  authsync_build_push: {
    description: 'Build an UNSIGNED EIP-12 transaction that replaces the auth-sync box. Sign it with the wallet that owns `address`. Records not listed are dropped, so pull first and send the full state.',
    schema: { address: z.string(), publicRecords: z.array(record).default([]), secretRecords: z.array(record).default([]), secret: z.string().optional() },
    async handler({ address, publicRecords, secretRecords, secret }) {
      const now = Date.now();
      const stamp = (rs) => rs.map((r) => ({ ...r, updatedAt: now }));
      const registers = await lib.encodeRegisters({ publicRecords: stamp(publicRecords), secretRecords: stamp(secretRecords), secret: secret ?? SECRET });
      const [inputs, h, latest] = await Promise.all([explorerUtxos(address), height(), lib.fetchLatestBox(address, EXPLORER)]);
      const previous = latest?.unspent ? latest.box : undefined;
      const tx = lib.buildSyncTx({ address, inputs, height: h, registers, previous });
      return { unsignedTx: tx.toEIP12Object() };
    }
  }
};
