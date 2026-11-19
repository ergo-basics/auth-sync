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
async function explorerAllBoxes(address) {
  const r = await fetch(`${EXPLORER}/api/v1/boxes/unspent/byAddress/${address}?limit=500`);
  if (!r.ok) throw new Error(`Explorer ${r.status}`);
  return (await r.json()).items.map((b) => ({ ...b, additionalRegisters: Object.fromEntries(Object.entries(b.additionalRegisters).map(([k, v]) => [k, v.serializedValue ?? v])) }));
}
async function height() {
  const r = await fetch(`${EXPLORER}/api/v1/networkState`);
  return (await r.json()).height;
}

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const verify = (...a) => lib.nodeVerifier(...a);

export const TOOLS = {
  authsync_pull: {
    description: 'Read ALL valid auth-sync boxes of an address (boxes without the owner signature are ignored) and merge them: per key, the highest creationHeight wins. Pass `secret` (or set AUTHSYNC_SECRET) to include encrypted entries. `lockedBoxes` lists boxes that could not be opened.',
    schema: { address: z.string(), secret: z.string().optional() },
    async handler({ address, secret }) {
      const merged = await lib.mergeBoxes(await lib.fetchBoxes(address, verify, EXPLORER), secret ?? SECRET);
      const { reclaimable, ...rest } = merged;
      return { ...rest, reclaimable: reclaimable.map((b) => b.box.boxId) };
    }
  },
  authsync_prepare_push: {
    description: 'STEP 1 of a write. Encodes the entries into box(es) and returns, for each box, the text `message` that the owner wallet must sign (EIP-12 auth, P2PK key of `address`). Keep the output unchanged: the ciphertext is random and the signature covers it. A null value deletes a key.',
    schema: { address: z.string(), publicEntries: z.record(z.any()).default({}), secretEntries: z.record(z.any()).default({}), secret: z.string().optional(), reclaim: z.boolean().default(true) },
    async handler({ address, publicEntries, secretEntries, secret, reclaim }) {
      const sec = secret ?? SECRET;
      const chunks = await lib.splitEntries(publicEntries, secretEntries);
      if (!chunks.length) throw new Error('Nothing to push.');
      const h = await height();
      const boxes = [];
      for (const c of chunks) {
        const r = await lib.encodeRegisters({ ...c, secret: sec });
        boxes.push({ R4: hex(r.R4), R5: hex(r.R5), R6: hex(r.R6), message: lib.signingMessage(r, h, address) });
      }
      const existing = await lib.fetchBoxes(address, verify, EXPLORER);
      const reclaimIds = [];
      if (reclaim) {
        const fresh = { ...publicEntries, ...secretEntries };
        const merged = await lib.mergeBoxes(existing, sec);
        for (const pb of existing) {
          if (!pb.unspent || merged.lockedBoxes.includes(pb.box.boxId)) continue;
          const c = await lib.decodeRegisters(pb.registers, sec);
          const keys = Object.keys({ ...c.publicEntries, ...(c.secretEntries ?? {}) });
          if (keys.every((k) => k in fresh || merged.sources[k] !== pb.box.boxId)) reclaimIds.push(pb.box.boxId);
        }
      }
      return { height: h, boxes, reclaimIds };
    }
  },
  authsync_build_push: {
    description: 'STEP 2 of a write. Takes the output of authsync_prepare_push plus the hex signature R7 of each box, and returns an UNSIGNED EIP-12 transaction for the owner wallet to sign and submit.',
    schema: { address: z.string(), height: z.number(), boxes: z.array(z.object({ R4: z.string(), R5: z.string(), R6: z.string(), R7: z.string() })), reclaimIds: z.array(z.string()).default([]) },
    async handler({ address, height: h, boxes, reclaimIds }) {
      const registers = boxes.map((b) => ({ R4: unhex(b.R4), R5: unhex(b.R5), R6: unhex(b.R6), R7: unhex(b.R7) }));
      for (const r of registers) {
        if (!(await verify(address, lib.messageBytes(lib.signingMessage(r, h, address)), r.R7))) {
          throw new Error('A signature does not match the box content, height and address.');
        }
      }
      const all = await explorerUtxos(address);
      const ids = new Set(reclaimIds);
      const existing = (await explorerAllBoxes(address)).filter((b) => ids.has(b.boxId));
      const tx = lib.buildSyncTx({ address, inputs: all, height: h, registers, reclaim: existing });
      return { unsignedTx: tx.toEIP12Object() };
    }
  }
};
