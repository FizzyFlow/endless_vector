# Endless Vector - JavaScript SDK

JavaScript/TypeScript SDK for interacting with the Endless Vector smart contract on the Sui blockchain. Endless Vector provides a scalable, on-chain data structure storing `vector<vector<u8>>` that can grow beyond Sui object size limits.

## Installation

```bash
npm install @fizzyflow/endless-vector
```

## Quick Start

### Creating a New Vector

```javascript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { EndlessVector } from '@fizzyflow/endless-vector';

const client = new SuiGrpcClient({ url: 'https://fullnode.mainnet.sui.io:443' });

// Create an empty vector
const vector = await EndlessVector.create({
    suiClient: client,
    packageId: 'testnet',  // or 'mainnet' or '0xYOUR_PACKAGE_ID'
    signAndExecuteTransaction: async (tx) => {
        const result = await wallet.signAndExecuteTransaction({ transaction: tx });
        return result.digest;
    }
});

// Or create with initial data
const vectorWithData = await EndlessVector.create({
    suiClient: client,
    packageId: 'testnet',  // or 'mainnet' or '0xYOUR_PACKAGE_ID'
    array: new Uint8Array([1, 2, 3]),  // single item
    //array: [new Uint8Array([1, 2, 3]), new Uint8Array([5, 6, 7])],  // or multiple items
    signAndExecuteTransaction: async (tx) => {
        const result = await wallet.signAndExecuteTransaction({ transaction: tx });
        return result.digest;
    }
});
```

### Reading an Existing Vector

```javascript
const vector = new EndlessVector({
    suiClient: client,
    id: '0xYOUR_VECTOR_OBJECT_ID'
});

await vector.initialize();

console.log('Total items:', vector.length);
console.log('Total size:', vector.binaryLength, 'bytes');

// Read items
const firstItem = await vector.at(0); // Uint8Array
```

## API Reference

### Static Methods

#### EndlessVector.create(params)

Creates a new EndlessVector on the blockchain.

**Parameters:**
- `suiClient` (SuiGrpcClient) - Sui gRPC client instance for blockchain interactions
- `packageId` (string) - 'testnet', 'mainnet', or ID of the Move package containing the EndlessVector module
- `signAndExecuteTransaction` (function) - Function to sign and execute transactions, must return the transaction digest
- `array` (Uint8Array or Uint8Array[], optional) - Optional first vector<u8>(s) to push to the new vector
- `gasCoin` (Object, optional) - Gas coin object reference `{objectId: string, digest: string, version: string}` for transaction payment
- `options` (Object, optional) - Additional options:
  - `timeout` (number) - Transaction confirmation timeout in ms (default: 30000)
  - `pollIntervalMs` (number) - Poll interval in ms (default: 1000)

**Returns:** Promise\<EndlessVector\>

**Example:**
```javascript
const vector = await EndlessVector.create({
    suiClient: client,
    packageId: 'testnet',  // or 'mainnet' or '0xPACKAGE_ID'
    array: new Uint8Array([1, 2, 3]),
    gasCoin: {
        objectId: '0xGAS_COIN_ID',
        digest: 'DIGEST',
        version: 'VERSION'
    },
    signAndExecuteTransaction: async (tx) => {
        const result = await wallet.signAndExecuteTransaction({ transaction: tx });
        return result.digest;
    }
});
```

### Constructor

```javascript
const vector = new EndlessVector({
    suiClient,                 // SuiGrpcClient instance (required for reading)
    id,                        // Object ID of the EndlessVector (required)
    packageId,                 // 'testnet', 'mainnet', or Package ID for write operations (optional)
    signAndExecuteTransaction  // Function to sign/execute transactions, must return digest (optional)
});
```

**Modes:**
- **Read-only mode**: Provide only `suiClient` and `id`
- **Writable mode**: Provide all parameters including `packageId` and `signAndExecuteTransaction`

### Properties

- `id` (string) - Object ID of the EndlessVector
- `isWritable` (boolean) - Whether the instance can perform write operations
- `length` (number) - Total number of items in the vector (never decreases, even after burns)
- `binaryLength` (number) - Total binary size of all items in bytes
- `historyItemsCount` (number) - Number of history segments in the current object
- `archiveItemsCount` (number) - Total number of archive entries ever created
- `archivedAtLength` (number) - `length` value at the time of the last archive operation
- `archivedFromLength` (number) - Items before this index have been burned and are no longer readable
- `burnedArchiveCount` (number) - Number of archive entries that have been burned
- `firstNotHistoryIndex` (number) - First index stored in the current object (not in history or archive)

### Methods

#### initialize()

Loads the vector's metadata from the blockchain. Called automatically by most methods.

```javascript
await vector.initialize();
```

#### reInitialize()

Forces a reload of the vector's metadata on the next access, clearing the items cache.

```javascript
vector.reInitialize();
await vector.initialize();
```

#### push(arr, params)

Pushes a `Uint8Array` (or array of `Uint8Array`) to the vector. Requires writable mode. Maximum size per item: ~120KB.

```javascript
await vector.push(new Uint8Array([1, 2, 3, 4, 5]));
```

**Parameters:**
- `arr` (Uint8Array or Uint8Array[]) - Data to push
- `params` (Object, optional) - `{ timeout, pollIntervalMs }`

**Returns:** Promise\<boolean\>

#### getPushTransaction(arr, tx)

Creates a transaction for pushing data without executing it. Useful for batching multiple pushes in one transaction.

```javascript
// Single push transaction
const tx = vector.getPushTransaction(new Uint8Array([1, 2, 3]));
await signAndExecuteTransaction(tx);

// Multiple pushes in one transaction
const tx = new Transaction();
vector.getPushTransaction(new Uint8Array([1, 2, 3]), tx);
vector.getPushTransaction(new Uint8Array([4, 5, 6]), tx);
await signAndExecuteTransaction(tx);
```

**Parameters:**
- `arr` (Uint8Array or Uint8Array[]) - Data to push
- `tx` (Transaction, optional) - Existing transaction to append to

**Returns:** Transaction

#### at(index)

Retrieves an item at a specific index. Throws if the index is out of range or has been burned.

```javascript
const item = await vector.at(42);  // Returns Uint8Array
```

**Parameters:**
- `index` (number) - Zero-based index

**Returns:** Promise\<Uint8Array\>

#### concat(other, params)

Concatenates another EndlessVector (or array of vectors) into this one. The other vector(s) are consumed (destroyed).

```javascript
// Concat single vector
await vector1.concat(vector2);

// Concat multiple vectors at once
await vector1.concat([vector2, vector3, vector4]);

// Also accepts object IDs
await vector1.concat('0xVECTOR2_ID');
await vector1.concat(['0xVECTOR2_ID', '0xVECTOR3_ID']);
```

**Parameters:**
- `other` (string | EndlessVector | Array\<string | EndlessVector\>) - Vector(s) to concatenate
- `params` (Object, optional) - `{ timeout, pollIntervalMs }`

**Returns:** Promise\<boolean\>

**Note:** Cannot concat a source vector that has archived items (`archiveItemsCount > 0`).

#### getConcatTransaction(other, tx)

Creates a transaction for concatenation without executing it.

```javascript
const tx = vector1.getConcatTransaction(vector2);
await signAndExecuteTransaction(tx);

// Or append to existing transaction
const tx = new Transaction();
vector1.getConcatTransaction([vector2, vector3], tx);
await signAndExecuteTransaction(tx);
```

**Parameters:**
- `other` (string | EndlessVector | Array\<string | EndlessVector\>) - Vector(s) to concatenate
- `tx` (Transaction, optional) - Existing transaction to append to

**Returns:** Transaction

#### archive(params)

Moves the current history segments into a new archive entry, freeing up history capacity for future pushes. Internally calls `clamp()` first, so any items currently in the object are also swept into the archive.

```javascript
await vector.archive();
```

**Parameters:**
- `params` (Object, optional) - `{ timeout, pollIntervalMs }`

**Returns:** Promise\<boolean\>

#### getArchiveTransaction(tx)

Creates an archive transaction without executing it.

```javascript
const tx = vector.getArchiveTransaction();
await signAndExecuteTransaction(tx);
```

**Parameters:**
- `tx` (Transaction, optional) - Existing transaction to append to

**Returns:** Transaction

#### burnArchive(params)

Permanently deletes the oldest archive entry. Items covered by the burned archive become unreadable — `at()` will throw for those indices. `archivedFromLength` advances by the number of items in the burned archive.

```javascript
await vector.burnArchive();
// items before vector.archivedFromLength are now gone
```

**Parameters:**
- `params` (Object, optional) - `{ timeout, pollIntervalMs }`

**Returns:** Promise\<boolean\>

#### getBurnArchiveTransaction(tx)

Creates a burn-archive transaction without executing it.

```javascript
const tx = vector.getBurnArchiveTransaction();
await signAndExecuteTransaction(tx);
```

**Parameters:**
- `tx` (Transaction, optional) - Existing transaction to append to

**Returns:** Transaction

## Usage Examples

### Archive and burn lifecycle

```javascript
// Push enough data to fill history, then archive
await vector.push(largeData);       // triggers clamp() → items move to history
await vector.archive();             // history → archive entry #0
await vector.initialize();

console.log(vector.archiveItemsCount);  // 1
console.log(vector.archivedAtLength);   // e.g. 5  (length at archive time)
console.log(vector.historyItemsCount);  // 0  (cleared)

// All items still readable, including archived ones
const item = await vector.at(0);

// When old data is no longer needed, burn the archive to reclaim storage
await vector.burnArchive();
await vector.initialize();

console.log(vector.burnedArchiveCount);  // 1
console.log(vector.archivedFromLength);  // e.g. 5  (items 0-4 are gone)

// at(0) now throws — burned
await vector.at(0);  // Error: this part of archive has been burned
```

### Custom Gas Coin for Parallel Operations

To execute transactions in parallel you need a separate gas coin per transaction:

```javascript
// Get available gas coins
const { objects: coins } = await client.listCoins({
    owner: address,
    coinType: '0x2::sui::SUI'
});
const gasCoinRefs = coins.map(c => ({
    objectId: c.objectId,
    digest: c.digest,
    version: c.version
}));

// Create vectors in parallel, each with its own gas coin
const vectors = await Promise.all(
    dataChunks.map((items, i) =>
        EndlessVector.create({
            suiClient: client,
            packageId: 'testnet',  // or 'mainnet' or '0xPACKAGE_ID'
            array: items,
            gasCoin: gasCoinRefs[i],
            signAndExecuteTransaction: async (tx) => {
                const result = await wallet.signAndExecuteTransaction({ transaction: tx });
                return result.digest;
            }
        })
    )
);
```

## Testing

```bash
pnpm test:base
```

Tests use [vitest](https://vitest.dev/) and require a local Sui validator with a Walrus localnet.

### Performance Considerations

- **Caching**: Loaded history and archive segments are cached per instance
- **Lazy Loading**: History/archive data is only fetched when accessed via `at()`
- **Batch Writes**: Use `getPushTransaction()` to combine multiple pushes in one transaction
- **Re-initialization**: After any write operation, metadata is refreshed on next read automatically

### Concatenation

The `concat()` method efficiently merges vectors by transferring ownership of internal data structures rather than copying items one by one.

**Restrictions:**
- Cannot concatenate a source vector that has archived items (`archiveItemsCount > 0`)
- The source vector(s) are consumed (destroyed) in the process
- All items from the source vector(s) are appended in order

## License

Apache-2.0

## Repository

https://github.com/fizzyFlow/endless_vector

## Author

[suidouble](https://github.com/suidouble)
