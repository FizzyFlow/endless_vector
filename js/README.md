# Endless Vector - JavaScript SDK

JavaScript/TypeScript SDK for interacting with the Endless Vector smart contract on the Sui blockchain. Endless Vector provides a scalable, on-chain data structure storing `vector<vector<u8>>` that can grow beyond Sui object size limits.

## Installation

```bash
npm install @fizzyflow/endless-vector
```

## Quick Start

### Creating a New Vector

```javascript
import { SuiClient } from '@mysten/sui/client';
import { EndlessVector } from '@fizzyflow/endless-vector';

const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' });

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
    array: new Uint8Array([1, 2, 3]),  // [0] to append to EndlessVector
    //array: [new Uint8Array([1, 2, 3]), new Uint8Array([5, 6, 7])],  // or [0] and [1] to append to EndlessVector
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
- `suiClient` (SuiClient) - Sui client instance for blockchain interactions
- `packageId` (string) - 'testnet', 'mainnet', or ID of the Move package containing the EndlessVector module
- `signAndExecuteTransaction` (function) - Function to sign and execute transactions
- `array` (Uint8Array or Uint8Array[], optional) - Optional first vector<u8>(s) to push back to the new vector
- `gasCoin` (Object, optional) - Gas coin object reference `{objectId: string, digest: string, version: string}` for transaction payment
- `options` (Object, optional) - Additional options:
  - `timeout` (number) - Transaction confirmation timeout in ms (default: 30000)
  - `pollIntervalMs` (number) - Poll interval in ms (default: 1000)

**Returns:** Promise<EndlessVector>

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
    suiClient,                 // SuiClient instance (required for reading)
    id,                        // Object ID of the EndlessVector (required)
    packageId,                 // 'testnet', 'mainnet', or Package ID for write operations (optional)
    signAndExecuteTransaction  // Function to sign/execute transactions (optional)
});
```

**Modes:**
- **Read-only mode**: Provide only `suiClient` and `id`
- **Writable mode**: Provide all parameters including `packageId` and `signAndExecuteTransaction`

### Properties

- `id` (string) - Object ID of the EndlessVector
- `isWritable` (boolean) - Whether the instance can perform write operations
- `length` (number) - Total number of items in the vector
- `binaryLength` (number) - Total binary size of all items in bytes
- `historyItemsCount` (number) - Number of history segments
- `archiveItemsCount` (number) - Number of archive segments
- `archivedFromLength` (number) - Starting index after burned archives
- `burnedArchiveCount` (number) - Number of archives that have been burned
- `firstNotHistoryIndex` (number) - First index stored in current object (not in history)

### Methods

#### initialize()

Loads the vector's metadata from the blockchain. Called automatically by most methods.

```javascript
await vector.initialize();
```

#### reInitialize()

Forces a reload of the vector's metadata, clearing caches.

```javascript
await vector.reInitialize();
```

#### push(arr, params)

Pushes a Uint8Array or few Uint8Array(Uint8Array[]) to the vector. Requires writable mode. Maximum size per push: ~120KB.

```javascript
const data = new Uint8Array([1, 2, 3, 4, 5]);
await vector.push(data);
```

**Parameters:**
- `arr` (Uint8Array or Uint8Array[]) - Data to push
- `params` (Object, optional) - Additional parameters

#### getPushTransaction(arr, tx)

Creates a transaction for pushing data without executing it. Useful for batching multiple pushes.

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

Retrieves an item at a specific index. Alias: `get(index)`

```javascript
const item = await vector.at(42);  // Returns Uint8Array
```

**Parameters:**
- `index` (number) - Zero-based index

**Returns:** Promise<Uint8Array>

#### concat(other)

Concatenates another EndlessVector (or array of vectors) into this one. The other vector(s) will be consumed.

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
- `other` (string | EndlessVector | Array<string | EndlessVector>) - Vector(s) to concatenate

**Returns:** Promise<void>

**Note:** Cannot concat vectors that have archived items.

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
- `other` (string | EndlessVector | Array<string | EndlessVector>) - Vector(s) to concatenate
- `tx` (Transaction, optional) - Existing transaction to append to

**Returns:** Transaction

## Usage Examples

```javascript
const vector = new EndlessVector({
    suiClient: client,
    id: '0xVECTOR_ID'
});

await vector.initialize();

// Read metadata
console.log('Items:', vector.length);
console.log('Size:', vector.binaryLength, 'bytes');
console.log('History segments:', vector.historyItemsCount);
console.log('Archive segments:', vector.archiveItemsCount);

// Read specific item
const item = await vector.at(42); // Uint8Array
```

### Custom Gas Coin for Parallel Operations

To execute transactions in parallel, speeding up data upload process, you would probably need separate gas coin for each tx:

```javascript
// Get available gas coins
const coins = await client.getCoins({
    owner: address,
    coinType: '0x2::sui::SUI'
});
const gasCoinRefs = coins.data.map(c => ({
    objectId: c.coinObjectId,
    digest: c.digest,
    version: c.version
}));

// Create vectors in parallel, each with its own gas coin
const vectors = await Promise.all(
    testData.map((items, i) =>
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

Run the test suite:

```bash
npm test
```

Tests use the TAP framework and require a configured local sui validator installed.

### Performance Considerations

- **Caching**: Loaded history and archive segments are cached
- **Lazy Loading**: History/archive data is only loaded when accessed
- **Batch Writes**: Use `getPushTransaction()` to combine multiple pushes in one transaction
- **Re-initialization**: After `push()` or `concat()`, metadata is refreshed on next read

### Concatenation

The `concat()` method efficiently merges vectors by transferring ownership of internal data structures rather than copying items one by one. This makes it very efficient for combining large datasets.

**Restrictions:**
- Cannot concatenate vectors that have archived items
- The concatenated vector is consumed (destroyed) in the process
- All items from concatenated vector(s) are appended in order

## License

Apache-2.0

## Repository

https://github.com/fizzyFlow/endless_vector

## Author

[suidouble](https://github.com/suidouble)
