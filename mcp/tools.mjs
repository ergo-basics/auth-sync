// Single registry of tools; used by the stdio server and the .service HTTP server.
import { z } from 'zod';
import * as lib from './_generated/lib.bundle.mjs';

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

export const TOOLS = {
  authsync_pull: {
    description: 'Read ALL auth-sync boxes of an address and merge them: per key, the highest block wins. Pass `secret` (or set AUTHSYNC_SECRET) to include encrypted entries. `lockedBoxes` lists boxes that could not be opened.',
    schema: { address: z.string(), secret: z.string().optional() },
    async handler({ address, secret }) {
      const merged = await lib.mergeBoxes(await lib.fetchBoxes(address, EXPLORER), secret ?? SECRET);
      const { reclaimable, ...rest } = merged;
      return { ...rest, reclaimable: reclaimable.map((b) => b.box.boxId) };
    }
  },
  authsync_build_push: {
    description: 'Build an UNSIGNED EIP-12 transaction that writes the given entries in new box(es) (split automatically if big). Other keys are untouched; a null value deletes a key. Obsolete boxes are spent to reclaim ERG. Sign it with the wallet that owns `address`.',
    schema: { address: z.string(), publicEntries: z.record(z.any()).default({}), secretEntries: z.record(z.any()).default({}), secret: z.string().optional(), reclaim: z.boolean().default(true) },
    async handler({ address, publicEntries, secretEntries, secret, reclaim }) {
      const sec = secret ?? SECRET;
      const chunks = await lib.splitEntries(publicEntries, secretEntries);
      if (!chunks.length) throw new Error('Nothing to push.');
      const registers = await Promise.all(chunks.map((c) => lib.encodeRegisters({ ...c, secret: sec })));
      const [inputs, h, existing] = await Promise.all([explorerUtxos(address), height(), lib.fetchBoxes(address, EXPLORER)]);
      let reclaimBoxes = [];
      if (reclaim) {
        const fresh = { ...publicEntries, ...secretEntries };
        const merged = await lib.mergeBoxes(existing, sec);
        for (const pb of existing) {
          if (!pb.unspent || merged.lockedBoxes.includes(pb.box.boxId)) continue;
          const c = await lib.decodeRegisters(pb.registers, sec);
          const keys = Object.keys({ ...c.publicEntries, ...(c.secretEntries ?? {}) });
          if (keys.every((k) => k in fresh || merged.sources[k] !== pb.box.boxId)) reclaimBoxes.push(pb.box);
        }
      }
      const tx = lib.buildSyncTx({ address, inputs, height: h, registers, reclaim: reclaimBoxes });
      return { boxes: registers.length, reclaimed: reclaimBoxes.map((b) => b.boxId), unsignedTx: tx.toEIP12Object() };
    }
  }
};
