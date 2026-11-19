# Auth-Sync: Encrypted Key-Value State in P2PK Boxes

* Author: 0xf965
* Status: Draft
* Created: 19-Nov-2026
* License: CC0
* Forking: not needed

> The EIP number is not assigned yet. When this is sent to
> [ergoplatform/eips](https://github.com/ergoplatform/eips), copy this file to
> `eip-00NN.md` with the next free number.

## Abstract

This document defines how an application stores a small key-value state in
boxes locked to the user's **own P2PK address**: some keys in clear text, some
encrypted. A user on a new device connects the same wallet, enters a secret and
gets the state back. No contract and no server are needed.

## Motivation

Applications keep user settings, preferences and sometimes hot-wallet seeds on
one device. Moving to another device means redoing everything. Cloud backups
need a trusted server, and a wallet cannot decrypt data by itself.

The blockchain already gives a public, permanent store that is bound to an
address. If many applications store their state in boxes in the same way, a
user gets sync across devices and across applications from one wallet.

[EIP-29](./eip-0029.md) also attached data to boxes, but it was revoked because
it failed on non-P2PK addresses. This EIP only uses P2PK boxes owned by the
user, so that problem does not apply. Because anyone can send a box to your address, this EIP adds an owner signature to each box (see Signature). It also differs in goal: EIP-29 is a
message attached to a payment, this EIP is a state that the owner reads back.

## Box format

An auth-sync box:

- is locked to the user's P2PK address. There is no contract. Only the owner can spend it;
- holds the registers below. R8 and R9 are free for other uses and are ignored;
- needs a value of at least `360 nanoERG` per serialized byte (the normal minimum box value).

| Register | Type | Content |
|----------|------|---------|
| R4 | `Coll[Byte]` | Header: bytes `41 53 59` (`"ASY"`) followed by a version byte. Version is `01`. |
| R5 | `Coll[Byte]` | UTF-8 JSON **object** `{ "key": value, ... }` with the unencrypted entries. `{}` if none. |
| R6 | `Coll[Byte]` | Envelope with the encrypted entries. **Empty** (`0e00`) if none. It is always present, because registers must be dense and R7 follows. |
| R7 | `Coll[Byte]` | Owner signature, 56 bytes (see Signature). |

A box is an auth-sync box only if R4 starts with `41 53 59` **and** its signature in R7 is valid (see Signature). Readers ignore any
other box, and ignore versions they do not know.

Example, a box with the public entry `{"theme":"dark"}`:

```
R4 = 0e0441535901
R5 = 0e107b227468656d65223a226461726b227d
R6 = 0e00
R7 = 0e38<56 bytes of signature>
```

### Keys and values

- A key is a UTF-8 string. Values are any JSON value.
- A key MUST NOT be in both R5 and the encrypted entries of the same box.
- A value of `null` means the key is **deleted**. It still takes precedence over older boxes (see Merge rule).
- Applications SHOULD prefix keys with their own name, for example `chatui/settings`, to avoid collisions.

### Encrypted entries (R6)

The encrypted entries are a JSON object like R5. They are compressed with
DEFLATE (raw, RFC 1951) and then encrypted.

```
envelope = version(1) || logN(1) || salt(16) || nonce(24) || ciphertext || tag(16)

version = 0x01
key     = scrypt(NFKC(secret) as UTF-8, salt, N = 2^logN, r = 8, p = 1, dkLen = 32)
cipher  = XChaCha20-Poly1305(key, nonce)
aad     = R4 || R5        (the raw content bytes of both registers)
```

- `logN` is 15 by default. Readers MUST refuse values below 10 or above 20.
- `salt` and `nonce` are random and MUST be new for every box.
- Because `aad` includes R5, the public entries cannot be replaced under the ciphertext.
- The secret is a passphrase that the user types. It is not derived from the wallet. A wallet
  signature cannot be used as the key, because the Schnorr signatures of Ergo are not deterministic.

## Signature

Anyone can send a box to any address, with any registers. Without a check, a stranger
could write entries into your state. So every auth-sync box carries in R7 a signature
made with the **private key of the P2PK address that holds the box**.

The signed text is:

```
message = "auth-sync:v1:" + hex( blake2b256(
    "auth-sync/v1" || 0x00 ||
    len32(R4) || R4 || len32(R5) || R5 || len32(R6) || R6 ||
    u32be(creationHeight) || utf8(address) ))
```

- `len32` and `u32be` are 4-byte big-endian integers. `R4`, `R5` and `R6` are the raw content bytes (not the serialized register).
- `creationHeight` is the `creationHeight` of the box. The writer MUST use the same value in the box and in the message.
- `address` is the base58 P2PK address of the box.
- `R7` is the Schnorr signature of the UTF-8 bytes of `message`, made by the key of `address`. It is the signature that `verify_signature(address, message, signature)` of ergo-lib checks, and the kind of signature that the EIP-12 `auth(address, message)` call returns.
- The message is printable text, so hardware wallets can show it.

A reader MUST ignore a box whose signature is missing or does not verify. It does not need to read the
transaction that created the box.

The box id is not in the message because it does not exist before the transaction. This
is safe: an attacker can copy a signed box (same registers, same `creationHeight`, even a different box id), but then
the copy has the same content and the same `creationHeight` as the original. It cannot override a newer state (see Merge rule).
It cannot change `creationHeight` either, because that would break the signature.

Each new box needs its own signature, so a write that creates N boxes asks the wallet for N signatures, plus the signature of the transaction itself.

## Merge rule

An address can have **many** valid auth-sync boxes, spent or unspent. The state of the
address is built like this:

1. Collect all auth-sync boxes of the address, **including spent ones**, and drop those with an invalid signature.
2. For each key, take the value from the box with the **highest `creationHeight`**. It is the height that the owner signed, so nobody else can choose it.
3. If two boxes with the same key have the same `creationHeight`, either value is valid. To make all readers
   agree, a reader SHOULD then prefer the higher `globalIndex`.
4. If the winning value is `null`, the key does not exist.

Spent boxes are included because an ordinary wallet transaction can spend an
auth-sync box as an input without meaning to delete the data.

The block height where the box was confirmed (`settlementHeight`) is **not** used. If it were, a stranger could
copy an old signed box and publish it later, and the old data would win.

A reader that has no secret can read R5 but not R6. It MUST report that some
boxes are locked, because a locked box can hold a newer value for a key.

## Writing

A writer builds a transaction that creates one or more auth-sync boxes to the
user's address.

- A write contains only the keys that change. Other keys are not touched.
- The writer sets the `creationHeight` of all new boxes to the current height, and signs each box (see Signature).
- The total of R4, R5 and R6 in one box SHOULD NOT be more than **3500 bytes** (R7 adds 58 more), so that the box stays under the 4 KB limit. If
  the entries do not fit, the writer splits them over several output boxes in the same transaction. A key MUST appear in only one of them.
- A writer SHOULD also spend, in the same transaction, older unspent auth-sync boxes whose keys are **all** replaced by newer values, to get their ERG back. A writer MUST NOT spend a box
  that it could not read (locked), because it cannot know if it is still needed.
- To move a key from public to encrypted or back, the writer only writes the new value. It wins by the Merge rule because its `creationHeight` is higher. The writer MUST NOT write `null` for the same key at the same `creationHeight`: both boxes would have the same `creationHeight`, and either one would be valid.

## Use cases

- Application settings, kept in an encrypted key such as `chatui/settings`.
- Hot-wallet mnemonics for other chains, kept encrypted.
- Pre-configured services (an id and its environment variables).

For a new device: connect the wallet (it can be a cold wallet that only signs
the upload), enter the secret, read all boxes, apply the merge rule.

## Security considerations

- **Public data is permanent.** R5 and all box history are readable by everyone for ever. Put only data
  that is safe to publish in R5. Even encrypted data is permanent: if the secret is weak or leaks, it cannot be taken back, and a later `null` does not erase the old box from the chain.
- **Use a strong secret.** An attacker can copy the ciphertext and try passphrases offline. scrypt slows this down, but it does not stop a weak passphrase.
- **Metadata leaks.** The address, the time, the number of boxes and the size of each box are public, even if the data is encrypted.
- **Key rotation.** To change the secret, the writer writes all encrypted keys again. The old ciphertexts stay on the chain and stay readable with the old secret.
- **Hot-wallet seeds.** Storing a seed on the chain, even encrypted, moves its security to the passphrase. Users SHOULD only do it for wallets with a small balance.
- **Forgery.** Anyone can create a box at your address, so the signature in R7 is what makes a box yours. A box without a valid signature is ignored. An attacker can still spam your address with invalid boxes; they cost the reader a signature check each but change nothing.
- **Replay.** A copy of an old signed box is valid, but it carries its old `creationHeight` and cannot override newer keys. It can bring back a key that you deleted with `null` only if the copy has a higher `creationHeight` than your delete, which is impossible.
- **Public entries are not signed one by one.** The signature covers the whole box. It proves that the owner wrote the box, not that the owner wants every old value to stay.
- **Wallet support.** The writer needs a wallet that signs a text message with the P2PK key. The signature must be the plain Schnorr one that `verify_signature` accepts. Wallets that cannot do this cannot write auth-sync boxes, but they can still read.
- **Size and cost.** Every box holds ERG while it is unspent. Reclaiming old boxes lowers the cost.

## Backward compatibility

No change to the protocol or to ErgoScript is needed. Wallets and explorers do
not need to know this EIP. An auth-sync box looks like a normal P2PK box with
extra registers, and registers R8 and R9 stay free.

A new `version` byte in R4 is used for later changes. Readers MUST ignore boxes
with a version that they do not support.

## Reference implementation

[ergo-basics/auth-sync](https://github.com/ergo-basics/auth-sync)

- `src/lib/core/codec.ts`: register encoding and decoding, splitting of entries.
- `src/lib/core/crypto.ts`: the envelope.
- `src/lib/core/chain.ts`: explorer reads, signature checks, the merge rule and the transaction builder.
- `src/lib/core/sign.ts`: the signed message.
- `mcp/`: an MCP server that exposes `authsync_pull` and `authsync_build_push`.
