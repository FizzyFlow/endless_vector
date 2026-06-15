# Endless Vector - Move Smart Contract

Move smart contract implementation for the Sui blockchain. Provides a scalable append-only structure that can grow beyond Sui's object size constraints through automatic data management across multiple storage tiers. Each item can hold either raw bytes or a [Walrus](https://walrus.xyz) blob reference. Optional [Seal](https://github.com/MystenLabs/seal) encryption is built in.

## Module

`endless_vector::endless_walrus`

## Key Features

- **Unlimited growth** — vector grows beyond Sui's object size limit through automatic history/archive tiers
- **Blob support** — items can be raw bytes or Walrus blob references; blobs don't count against the object's size limit
- **Seal encryption** — attach an AES key once; SDKs encrypt/decrypt every item transparently
- **Blob lifetime management** — inspect minimum blob expiry and extend all blobs to a target epoch in one call
- **Efficient concatenation** — merge vectors by transferring ownership, not copying data
- **Storage rebates** — burn old archives to reclaim storage fees
- **Binary search** — O(log n) lookups in history and archive tiers

## Overview

### Storage tiers

1. **Items** — most-recent items stored directly on the object (`this_object_storage_volume` ≤ `SAFE_INNER_SIZE = 128 KB`)
2. **History table** — older items clamped from the items vector when size limits are approached
3. **Archive table** — history swept here via `archive()`; each archive is a separate on-chain object that can be burned independently

### Item types (`EndlessWalrusItem`)

Each item holds either:
- **Bytes** — inline `vector<u8>`; counted fully in the object's storage volume
- **Blob** — a `walrus::blob::Blob` handle (32-byte object reference); data lives in Walrus, only the reference counts (~32 bytes) against object size

## Quick Start

```move
use endless_vector::endless_walrus;

// Create
let mut ev = endless_walrus::empty(ctx);

// Push bytes
endless_walrus::push_back_bytes(&mut ev, b"Hello");
endless_walrus::push_back_bytes(&mut ev, b"World");

// Push a Walrus blob
endless_walrus::push_back_blob(&mut ev, certified_blob);

// Read bytes
let bytes = endless_walrus::read_bytes_at(&ev, 0);  // b"Hello"

// Metadata
let len  = endless_walrus::length(&ev);  // 3
let size = endless_walrus::size(&ev);    // total binary bytes
```

## Data Structures

### EndlessWalrusVector

```move
public struct EndlessWalrusVector has key, store {
    id: UID,
    items: vector<EndlessWalrusItem>,
    first_item_is_from_previous_history: bool,

    length: u64,                           // total item count (never decreases)
    binary_length: u64,                    // total payload bytes (never decreases)
    this_object_items_binary_length: u64,  // payload bytes in current items tier
    this_object_storage_volume: u64,       // storage bytes in current items tier

    history: Option<Table<u64, EndlessWalrusHistory>>,
    history_items_count: u64,

    archive: Table<u64, EndlessWalrusArchive>,
    archive_items_count: u64,
    archived_at_length: u64,

    archived_from_length: u64,
    burned_archive_count: u64,

    made_with_version: u64,
    meta: vector<u8>,

    seal_encrypted_key: Option<vector<u8>>,  // Seal-wrapped AES key; set once
}
```

### EndlessWalrusHistory

```move
public struct EndlessWalrusHistory has store {
    items: vector<EndlessWalrusItem>,
    followed_by_next_bytes: u64,
    first_item_is_from_previous_history: bool,
    saved_at_length: u64,
    storage_volume: u64,
}
```

### EndlessWalrusArchive

```move
public struct EndlessWalrusArchive has store, key {
    id: UID,
    history: Table<u64, EndlessWalrusHistory>,
    archived_at_length: u64,
    length: u64,
}
```

## Public Functions

### Creation

#### `empty(ctx): EndlessWalrusVector`

Creates and returns a new empty vector.

```move
public fun empty(ctx: &mut TxContext): EndlessWalrusVector
```

#### `empty_entry(ctx)`

Entry function — creates a vector and transfers it to the sender.

```move
public fun empty_entry(ctx: &mut TxContext)
```

#### `transfer_to_sender(endless_v, ctx)`

Transfers an existing vector to the transaction sender.

```move
public fun transfer_to_sender(endless_v: EndlessWalrusVector, ctx: &mut TxContext)
```

#### `empty_and_push(items_to_push, ctx): EndlessWalrusVector`

Creates a vector and pushes multiple byte items.

```move
public fun empty_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext): EndlessWalrusVector
```

#### `empty_entry_and_push(items_to_push, ctx)`

Entry function wrapper around `empty_and_push`; transfers the result to the sender.

```move
public fun empty_entry_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext)
```

### Seal

#### `set_seal_encrypted_key(ev, key)`

Attaches a Seal-encrypted AES key to the vector. Can only be called once. After this, SDKs treat every item as encrypted.

```move
public fun set_seal_encrypted_key(ev: &mut EndlessWalrusVector, key: vector<u8>)
```

**Aborts:** `ESealKeyAlreadySet` (103) if called a second time.

#### `seal_encrypted_key(ev): &Option<vector<u8>>`

Borrows the Seal-encrypted AES key (or `none` if unencrypted).

```move
public fun seal_encrypted_key(ev: &EndlessWalrusVector): &Option<vector<u8>>
```

#### `is_sealed(ev): bool`

Returns `true` if the vector has a Seal key attached.

```move
public fun is_sealed(ev: &EndlessWalrusVector): bool
```

#### `seal_approve_endless_vector_owner(id, ev, ctx)`

Seal access policy. Approves decryption iff the PTB sender owns the vector. The `id` is the vector's 32-byte object address. Called internally by Seal; not meant for direct invocation.

```move
public fun seal_approve_endless_vector_owner(id: vector<u8>, ev: &EndlessWalrusVector, _ctx: &TxContext)
```

**Aborts:** `EIdMismatch` (102) if `id` does not match the vector's UID.

### Reading

#### `length(ev): u64`

Total item count (includes history and archive; never decreases).

```move
public fun length(endless_v: &EndlessWalrusVector): u64
```

#### `size(ev): u64`

Total payload bytes across all tiers (never decreases).

```move
public fun size(endless_v: &EndlessWalrusVector): u64
```

#### `has_items_from(ev): u64`

Starting index after burned archives (`archived_from_length`).

```move
public fun has_items_from(endless_v: &EndlessWalrusVector): u64
```

#### `history_items_count(ev): u64`

Number of history segments in the current object.

```move
public fun history_items_count(endless_v: &EndlessWalrusVector): u64
```

#### `archive_items_count(ev): u64`

Total archive entries created.

```move
public fun archive_items_count(endless_v: &EndlessWalrusVector): u64
```

#### `get_at(ev, i): &EndlessWalrusItem`

Returns a reference to the item at logical index `i`. For split items, returns the head fragment.

```move
public fun get_at(endless_v: &EndlessWalrusVector, i: u64): &EndlessWalrusItem
```

**Aborts:** `EArchiveHasBeenBurned` (92) if the index falls in a burned range.

#### `read_bytes_at(ev, i): vector<u8>`

Returns the full bytes at index `i`, reassembling split fragments.

```move
public fun read_bytes_at(endless_v: &EndlessWalrusVector, i: u64): vector<u8>
```

**Aborts:** `ENotABytesItem` (100) if the item is a Blob.

#### `borrow_blob_at(ev, i): &Blob`

Borrows the Walrus blob at index `i`.

```move
public fun borrow_blob_at(endless_v: &EndlessWalrusVector, i: u64): &Blob
```

**Aborts:** `ENotABlobItem` (101) if the item is not a Blob.

### Writing

#### `push_back(ev, item)`

Appends an `EndlessWalrusItem`. Triggers clamping automatically if `this_object_storage_volume` would exceed `SAFE_INNER_SIZE`.

```move
public fun push_back(endless_v: &mut EndlessWalrusVector, new_item: EndlessWalrusItem)
```

**Aborts:** `EChunkIsTooLarge` (91) if a single item's storage volume exceeds `SAFE_INNER_SIZE`.

#### `push_back_bytes(ev, bytes)`

Convenience wrapper — creates a bytes item and calls `push_back`.

```move
public fun push_back_bytes(endless_v: &mut EndlessWalrusVector, bytes: vector<u8>)
```

#### `push_back_blob(ev, blob)`

Appends a Walrus blob item. The blob reference counts ~32 bytes against object size; data lives in Walrus.

```move
public fun push_back_blob(endless_v: &mut EndlessWalrusVector, blob: Blob)
```

#### `compose_and_push_back(ev, bytes1..bytes10)`

Pushes up to 10 chunks as one item. Workaround for Sui's `max_pure_argument_size` (~12 KB per argument).

```move
public fun compose_and_push_back(
    endless_v: &mut EndlessWalrusVector,
    bytes1: vector<u8>, bytes2: vector<u8>, ..., bytes10: vector<u8>
)
```

**Purpose:** 10 × 12 KB = ~120 KB per transaction, covering the full `max_tx_size_bytes` (128 KB, base64-encoded).

#### `update_at(ev, i, new_item)`

Replaces the item at index `i`. Burns the old item. Can update items in both the current tier and history.

```move
public fun update_at(endless_v: &mut EndlessWalrusVector, i: u64, new_item: EndlessWalrusItem)
```

**Aborts:**
- `EIndexOutOfBounds` (96) — index ≥ length
- `ECannotUpdateArchivedItem` (93) — index is in the archived range
- `ESizeExceedsLimit` (94) — replacement would exceed tier's size limit
- `ECannotUpdateSplitItem` (95) — item straddles a history boundary

#### `update_bytes_at(ev, i, bytes)`

Convenience wrapper — creates a bytes item and calls `update_at`.

```move
public fun update_bytes_at(endless_v: &mut EndlessWalrusVector, i: u64, bytes: vector<u8>)
```

### Concatenation

#### `concat(ev, other)`

Appends all items from `other` by transferring ownership. `other` is consumed (destroyed).

```move
public fun concat(endless_v: &mut EndlessWalrusVector, other: EndlessWalrusVector)
```

**Restrictions:**
- Neither vector may have archived items (`ECannotConcatWithArchivedItems` 97)
- Neither vector may be Seal-encrypted (`ECannotConcatSealedVector` 104) — re-encrypting under one key is not supported

**Behavior:** transfers history items and current items directly without item-by-item copying; adjusts `saved_at_length` offsets accordingly.

#### `append(ev, others)`

Concatenates multiple vectors into `ev` by calling `concat` in order. All vectors in `others` are consumed.

```move
public fun append(endless_v: &mut EndlessWalrusVector, others: vector<EndlessWalrusVector>)
```

### Archive Management

#### `archive(ev, ctx)`

Moves all history into a new archive entry (a separate on-chain object). Resets the history table.

```move
public fun archive(endless_v: &mut EndlessWalrusVector, ctx: &mut TxContext)
```

#### `burn_archive(ev)`

Permanently deletes the oldest archive entry and recovers its storage rebate. Advances `archived_from_length`.

```move
public fun burn_archive(endless_v: &mut EndlessWalrusVector)
```

**Warning:** irreversible — items in the burned range are gone permanently.

#### `flush(ev)`

Clears all data (items, history, archives) and resets all counters to zero. The vector object itself is retained.

```move
public fun flush(endless_v: &mut EndlessWalrusVector)
```

**Warning:** irreversible.

#### `burn(ev)`

Calls `flush` then destroys the vector object entirely, deleting its UID.

```move
public fun burn(endless_v: EndlessWalrusVector)
```

### Walrus Blob Lifetime

#### `min_blob_end_epoch(ev): Option<u32>`

Returns the earliest `end_epoch` across all blobs in the vector (items + history + non-burned archives). Returns `none` if there are no blobs.

```move
public fun min_blob_end_epoch(endless_v: &EndlessWalrusVector): Option<u32>
```

#### `extend_blobs_to_epoch(ev, walrus_system, target_end_epoch, payment)`

Extends every blob whose `end_epoch < target_end_epoch` up to `target_end_epoch`. Skips blobs already valid through the target and expired blobs (which Walrus cannot extend). Covers items, history, and non-burned archives.

```move
public fun extend_blobs_to_epoch(
    endless_v: &mut EndlessWalrusVector,
    walrus_system: &mut System,
    target_end_epoch: u32,
    payment: &mut Coin<WAL>,
)
```

#### `extend_blobs_to_epoch_entry(ev, walrus_system, target_end_epoch, payment)`

Entry function wrapper around `extend_blobs_to_epoch`.

```move
public entry fun extend_blobs_to_epoch_entry(
    endless_v: &mut EndlessWalrusVector,
    walrus_system: &mut System,
    target_end_epoch: u32,
    payment: &mut Coin<WAL>,
)
```

#### `extend_blobs_cost_to_epoch(ev, walrus_system, target_end_epoch, price_per_unit): u64`

Returns the total WAL cost (in FROST) to extend all blobs to `target_end_epoch`. Designed for off-chain simulation (`devInspect`) to determine the exact payment amount before calling `extend_blobs_to_epoch`.

```move
public fun extend_blobs_cost_to_epoch(
    endless_v: &EndlessWalrusVector,
    walrus_system: &System,
    target_end_epoch: u32,
    price_per_unit: u64,
): u64
```

`price_per_unit` is the system's `storage_price_per_unit_size` (read from `WalrusClient.systemState` off-chain, since the on-chain getter is test-only).

## Constants

```move
const SAFE_INNER_SIZE: u64 = 128 * 1024;  // 128 KB
```

Controls the maximum `this_object_storage_volume`. When a push would exceed this, the current items are clamped to history automatically.

## Error Codes

```move
const EChunkIsTooLarge: u64 = 91;               // Single item storage volume exceeds SAFE_INNER_SIZE
const EArchiveHasBeenBurned: u64 = 92;          // Attempted access to a burned archive range
const ECannotUpdateArchivedItem: u64 = 93;      // Tried to update an item in the archived range
const ESizeExceedsLimit: u64 = 94;              // Replacement would exceed tier's storage limit
const ECannotUpdateSplitItem: u64 = 95;         // Item straddles a history boundary
const EIndexOutOfBounds: u64 = 96;              // Index ≥ length
const ECannotConcatWithArchivedItems: u64 = 97; // Concat source has archived items
const ENotABytesItem: u64 = 100;                // Expected bytes item, got blob or empty
const ENotABlobItem: u64 = 101;                 // Expected blob item, got bytes or empty
const EIdMismatch: u64 = 102;                   // Seal approval: id does not match vector UID
const ESealKeyAlreadySet: u64 = 103;            // set_seal_encrypted_key called twice
const ECannotConcatSealedVector: u64 = 104;     // Cannot concat Seal-encrypted vectors
```

## Storage Architecture

### Tier 1: Items vector

Stores the most-recent items directly on the `EndlessWalrusVector` object. Capped at `SAFE_INNER_SIZE` (128 KB) measured by `this_object_storage_volume`. Blob items contribute only ~32 bytes each regardless of payload size.

### Tier 2: History table (`Option<Table<u64, EndlessWalrusHistory>>`)

When a push would exceed the tier 1 limit, `clamp()` drains the current items into a new `EndlessWalrusHistory` segment with index `history_items_count`. Binary search over `saved_at_length` locates the correct segment in O(log n).

### Tier 3: Archive table (`Table<u64, EndlessWalrusArchive>`)

Calling `archive()` sweeps the entire history table into a new `EndlessWalrusArchive` child object, freeing the history table for new segments. Archives are indexed by `archive_items_count`. Calling `burn_archive()` deletes the oldest archive and returns its storage rebate.

### Item splitting

When a bytes item is too large to fit entirely in the remaining space of a history segment, `clamp()` splits it: the head fragment stays as the last item of the closing segment (`followed_by_next_bytes` records the tail size) and the tail becomes the first item of the new tier 1 (`first_item_is_from_previous_history = true`). `read_bytes_at()` reassembles the full item transparently.

## Building

```bash
sui move build
```

## Testing

```bash
sui move test --gas-limit=9999999999999999
```

Tests cover: basic push/get, large items, blobs, concat/append, archive and burn, update (in items and history), Seal encryption, Walrus blob extend.

## License

Apache-2.0

## Repository

https://github.com/fizzyFlow/endless_vector

## Author

[suidouble](https://github.com/suidouble)
