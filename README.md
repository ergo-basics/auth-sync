# ergo-basics / auth-sync

Keep encrypted app settings, hot-wallet mnemonics and other data in **one Ergo box
of your own address**. On a new device, connect the wallet, enter your secret, and
pull everything back. See [`IDEA.md`](./IDEA.md) for the original idea.

## Box format (v1)

The box is locked to the user's own address. There is no contract.

| Register | Type | Content |
|---|---|---|
| R4 | `Coll[Byte]` | header: `"ASY"` + version byte |
| R5 | `Coll[Byte]` | UTF-8 JSON `{"records":[...]}`, **unencrypted** |
| R6 | `Coll[Byte]` | envelope with the **encrypted** records (optional) |

Record: `{ id, kind, data, updatedAt }`. Kinds in use: `settings`, `mnemonic`, `app-config`.

Encryption: scrypt (N=2^15) from a secret → XChaCha20-Poly1305. The authenticated
data is `R4 || R5`, so the public part cannot be swapped under the ciphertext.
The secret is a passphrase you type; it is never sent anywhere.

Rules:
- **Newest box wins.** Order is `(settlementHeight, globalIndex)`. Spent boxes count too,
  because an ordinary wallet transaction may spend the box without meaning to delete the data.
- Each push spends the previous box (if unspent) and creates a new one, so the ERG is reused.
- Size limit: the registers hold at most 3600 bytes (an Ergo box is 4 KB). Data is deflated first.

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
await sync.push({ secretRecords: [{ id: 'chatui/settings', kind: 'settings', data: {...}, updatedAt: Date.now() }], secret });
const bundle = await sync.pull(secret);
```

## Status

- Done: core codec + crypto + newest-box rule (tests), browser signer, web app, stdio MCP (read + unsigned write).
- Not done: seed signer for Node, `.service/` Celaut package, live test against mainnet/testnet.
- Known limit: no key rotation yet; to change the secret, pull and push again.
