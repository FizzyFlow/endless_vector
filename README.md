# Endless Vector - JavaScript SDK

JavaScript/TypeScript SDK for the Endless Vector smart contract on [Sui](https://sui.io). Endless Vector is a scalable, append-only on-chain `vector<vector<u8>>` that grows beyond Sui object size limits by automatically splitting data into history segments. Items larger than ~120 KB are transparently stored as [Walrus](https://walrus.xyz) blobs. Optional [Seal](https://github.com/nicola/seal) encryption protects all stored data with AES-256-GCM.

## Installation

```bash
npm install @fizzyflow/endless-vector
```

## Quick Start

```javascript
import { EndlessVector } from '@fizzyflow/endless-vector';

// Create
const ev = await EndlessVector.create({
    suiClient: client,
    packageId: 'testnet', // or 'mainnet', or an explicit 0x... package ID
    signAndExecuteTransaction: async (tx) => {
        const result = await wallet.signAndExecuteTransaction({ transaction: tx });
        return result.digest;
    },
});

// Write
await ev.push(new Uint8Array([1, 2, 3]));

// Read
const item = await ev.at(0); // Uint8Array
```

## Constructor

```javascript
const ev = new EndlessVector(params);
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `suiClient` | SuiGrpcClient | yes | Sui gRPC client instance |
| `id` | string | yes | On-chain object ID of the vector |
| `packageId` | string | no | Move package ID, or `'testnet'`/`'mainnet'`. Enables writes |
| `signAndExecuteTransaction` | function | no | Signs and submits a Transaction, returns its digest. Enables writes |
| `walrusClient` | WalrusClient | no | `@mysten/walrus` client for blob read/write |
| `publisherUrl` | string | no | Walrus publisher HTTP URL (fallback when no `walrusClient`) |
| `aggregatorUrl` | string | no | Walrus aggregator HTTP URL (fallback when no `walrusClient`) |
| `senderAddress` | string | no | Sender Sui address, required for Walrus blob writes |
| `sealClient` | SealClient | no | `@mysten/seal` client for encryption/decryption |
| `sessionKey` | SessionKey | no | Pre-built Seal SessionKey. Alternative to `signer` |
| `signer` | Signer | no | Keypair or wallet signer used to auto-create a SessionKey when needed |
| `sealTtlMin` | number | no | SessionKey TTL in minutes (default: 5) |

Providing only `suiClient` + `id` gives a **read-only** instance. Add `packageId` + `signAndExecuteTransaction` for **writes**. Add Walrus params for **large items** (>120 KB). Add Seal params for **encryption**.

## EndlessVector.create(params)

Creates a new on-chain vector.

Accepts all constructor params above, plus:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `array` | Uint8Array \| Uint8Array[] | no | Initial item(s) to push |
| `gasCoin` | `{objectId, digest, version}` | no | Explicit gas coin for parallel creation |
| `options.timeout` | number | no | Tx confirmation timeout, ms (default: 30000) |
| `options.pollIntervalMs` | number | no | Tx poll interval, ms (default: 1000) |

When `sealClient` is provided, the vector is created with Seal encryption enabled. A random AES-256-GCM key is generated, Seal-wrapped scoped to the new vector's object ID, and stored on-chain. Any initial `array` items are encrypted before storage.

```javascript
const ev = await EndlessVector.create({
    suiClient: client,
    packageId: 'testnet',
    sealClient,
    signer: keypair,
    signAndExecuteTransaction: sign,
});
// All push() / at() calls now encrypt/decrypt transparently
```

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Object ID |
| `isWritable` | boolean | Whether writes are enabled |
| `length` | number | Total item count (append-only, never decreases) |
| `binaryLength` | number | Total size of all items in bytes |
| `sealEncryptedKey` | Uint8Array \| null | Seal-wrapped AES key, or null if unencrypted |
| `seal` | EndlessVectorSeal | Seal companion (always present; active only when `sealClient` was provided) |
| `walrus` | EndlessVectorWalrus | Walrus companion (always present; active only when Walrus params were provided) |
| `historyItemsCount` | number | History segments in the current object |
| `archiveItemsCount` | number | Total archive entries ever created |
| `archivedAtLength` | number | `length` at the time of the last archive |
| `archivedFromLength` | number | Items before this index have been burned |
| `burnedArchiveCount` | number | Burned archive count |
| `firstNotHistoryIndex` | number | First index stored in the current object |

## Methods

### initialize()

Loads metadata from chain. Most read methods call this internally.

```javascript
await ev.initialize();
```

### reInitialize()

Marks the instance stale so the next operation re-fetches from chain.

```javascript
ev.reInitialize();
```

### isEncrypted()

Async. Returns `true` if the vector has a Seal encryption key on-chain. Calls `initialize()` internally.

```javascript
if (await ev.isEncrypted()) { /* ... */ }
```

### push(arr, params?)

Appends one or more `Uint8Array` items. Requires writable mode.

- Items up to ~120 KB are stored on-chain as `vector<u8>`.
- Larger items are stored as Walrus blobs (requires Walrus params).
- On encrypted vectors, every item is AES-256-GCM encrypted before storage (28 bytes overhead per item).

```javascript
await ev.push(new Uint8Array([1, 2, 3]));
await ev.push([chunk1, chunk2, chunk3]); // multiple items
```

### getPushTransaction(arr, tx?)

Returns a `Transaction` without executing it. Useful for batching multiple pushes.

```javascript
const tx = new Transaction();
ev.getPushTransaction(data1, tx);
ev.getPushTransaction(data2, tx);
await signAndExecuteTransaction(tx);
```

### at(index)

Reads the item at a zero-based index. On encrypted vectors, decrypts transparently.

```javascript
const data = await ev.at(0); // Uint8Array
```

### concat(other, params?)

Appends all items from another vector (or array of vectors) into this one. Sources are consumed (destroyed).

```javascript
await ev.concat(otherVector);
await ev.concat([v2, v3]);
await ev.concat('0xOTHER_VECTOR_ID');
```

**Restrictions:** cannot concat vectors that have archived items or that are Seal-encrypted.

### getConcatTransaction(other, tx?)

Returns a concat `Transaction` without executing.

### archive(params?)

Sweeps current history segments into a new archive entry, freeing capacity for future pushes.

```javascript
await ev.archive();
```

### getArchiveTransaction(tx?)

Returns an archive `Transaction` without executing.

### burnArchive(params?)

Permanently deletes the oldest archive entry. Items in the burned range become unreadable.

```javascript
await ev.burnArchive();
// ev.archivedFromLength now advanced; at() throws for burned indices
```

### getBurnArchiveTransaction(tx?)

Returns a burn-archive `Transaction` without executing.

## Walrus Blob Storage

When Walrus params are configured, items larger than ~120 KB are automatically stored as Walrus blobs instead of on-chain `vector<u8>`. The SDK handles upload, certification, and read-back. On encrypted vectors, blobs contain ciphertext only.

```javascript
const ev = new EndlessVector({
    suiClient: client,
    id: '0x...',
    packageId: 'testnet',
    walrusClient,                       // or aggregatorUrl + publisherUrl
    senderAddress: wallet.address,
    signAndExecuteTransaction: sign,
});

await ev.push(largeFile); // >120 KB → stored as Walrus blob
const data = await ev.at(0); // fetched from Walrus transparently
```

## Seal Encryption

Seal provides end-to-end encryption for vector items. The access policy (`seal_approve_endless_vector_owner`) ensures only the vector owner can decrypt.

### Creating an encrypted vector

```javascript
const ev = await EndlessVector.create({
    suiClient: client,
    packageId: 'testnet',
    sealClient,
    signer: keypair,
    signAndExecuteTransaction: sign,
});
// AES key generated → Seal-wrapped → stored on-chain
// All push()/at() calls encrypt/decrypt transparently
```

### Reading an encrypted vector

You can provide a `signer` and the SDK auto-creates a SessionKey:

```javascript
const ev = new EndlessVector({
    suiClient: client,
    id: '0x...',
    sealClient,
    signer: keypair,          // SDK creates a 5-minute SessionKey automatically
});
const data = await ev.at(0); // decrypted
```

Or provide a pre-built `sessionKey` (useful in browser wallets where signing is interactive):

```javascript
const ev = new EndlessVector({
    suiClient: client,
    id: '0x...',
    sealClient,
    sessionKey: mySessionKey, // created externally, e.g. via wallet adapter
});
const data = await ev.at(0); // decrypted using the provided SessionKey
```

You can also set the session key after construction:

```javascript
ev.seal._sessionKey = mySessionKey;
```

### How it works

1. `create()` generates a random AES-256-GCM key
2. The key is Seal-wrapped scoped to the vector's object ID and stored on-chain as `seal_encrypted_key`
3. `push()` encrypts each item before storage (adds 28 bytes: 12B nonce + 16B GCM tag)
4. `at()` unwraps the AES key via Seal (requires a valid SessionKey), then decrypts the item
5. The unwrapped AES key is cached in memory for subsequent reads

Passing `sealClient` to an unencrypted vector is safe — `push()` and `at()` check for the on-chain `sealEncryptedKey` before attempting any encryption/decryption.

## Examples

### Archive and burn lifecycle

```javascript
await ev.push(largeData);
await ev.archive();
await ev.initialize();

console.log(ev.archiveItemsCount);  // 1
console.log(ev.archivedAtLength);   // e.g. 5

const item = await ev.at(0); // still readable

await ev.burnArchive();
await ev.initialize();

console.log(ev.burnedArchiveCount);  // 1
console.log(ev.archivedFromLength);  // 5 — items 0..4 are gone
await ev.at(0); // throws
```

### Parallel vector creation with gas coins

```javascript
const vectors = await Promise.all(
    dataChunks.map((chunk, i) =>
        EndlessVector.create({
            suiClient: client,
            packageId: 'testnet',
            array: chunk,
            gasCoin: gasCoinRefs[i],
            signAndExecuteTransaction: sign,
        })
    )
);
```

## Testing

```bash
pnpm test:base    # core tests
pnpm test:seal    # seal encryption tests
```

Tests use [vitest](https://vitest.dev/) and require [seal_walrus_localnet](https://github.com/FizzyFlow/seal_walrus_localnet) running on a local Sui validator.

## License

Apache-2.0

## Links

- [Repository](https://github.com/fizzyFlow/endless_vector)
- [npm](https://www.npmjs.com/package/@fizzyflow/endless-vector)
- [Author](https://github.com/suidouble)
