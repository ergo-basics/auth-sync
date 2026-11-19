# ergo-basics / auth-sync

Keep encrypted app settings, hot-wallet mnemonics and other data in **one Ergo box
of your own address**. On a new device, connect the wallet, enter your secret, and
pull everything back. The format is specified in [`EIP.md`](./EIP.md); see [`IDEA.md`](./IDEA.md) for the original idea.

## Box format (v1)

The box is locked to the user's own address. There is no contract.

| Register | Type | Content |
|---|---|---|
| R4 | `Coll[Byte]` | header: `"ASY"` + version byte |
| R5 | `Coll[Byte]` | UTF-8 JSON **object** `{key: value}`, unencrypted |
| R6 | `Coll[Byte]` | envelope with an encrypted JSON object `{key: value}` (optional) |

Encryption: scrypt (N=2^15) from a secret → XChaCha20-Poly1305. The authenticated
data is `R4 || R5`, so the public part cannot be swapped under the ciphertext.
The secret is a passphrase you type; it is never sent anywhere.

Rules:
- **Many boxes are allowed.** The state is the union of all auth-sync boxes of the address.
- **Same key in several boxes: the box at the highest block wins.** If they share the
  block, either value is valid (readers order by `globalIndex` only to agree with each other).
- A key can be public or secret, not both in one box. A `null` value deletes the key
  (it still shadows older boxes).
- Spent boxes count too, because an ordinary wallet transaction may spend a box
  without meaning to delete the data.
- A push writes only the keys you give. Entries that do not fit in one box (3600 bytes
  of registers, deflated first) are split over several outputs of the same transaction.
- A push also spends older unspent boxes whose keys are all replaced, so their ERG is reused.
  Boxes that are locked (no secret given) are never reclaimed.

## Use

```bash
npm install
npm run dev          # web app
npm test             # core tests
npm run build:mcp    # bundle src/lib/core for the MCP
npm run mcp          # stdio MCP: authsync_pull, authsync_build_push (unsigned)
```

```ts
import { AuthSync } from 'auth-sync';
const sync = new AuthSync(signer);
await sync.push({ secretEntries: { 'chatui/settings': { theme: 'dark' } }, secret });
const { entries } = await sync.pull(secret); // merged view
```

## Status

- Done: core codec + crypto + multi-box merge rule (tests), browser signer, web app, stdio MCP (read + unsigned write).
- Not done: seed signer for Node, `.service/` Celaut package, live test against mainnet/testnet.
- Known limit: no key rotation yet; to change the secret, pull and push all keys again.
