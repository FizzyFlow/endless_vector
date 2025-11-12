# Endless Vector - Move Smart Contract

Move smart contract implementation of an endless vector data structure for the Sui blockchain. Provides a scalable `vector<vector<u8>>` that can grow beyond Sui's object size constraints through automatic data management across multiple storage tiers.

## Overview

The Endless Vector smart contract provides a scalable vector that can grow indefinitely through automatic data management across three storage tiers: current items, history table, and archive table. It efficiently handles large datasets while respecting Sui's object size limits.

## Key Features

- **Unlimited Growth**: Vector can grow beyond Sui's 250KB object size limit indefinitely
- **Large Item Support**: Push items up to ~200KB each, or compose up to ~120KB per transaction
- **Three-Tier Storage**: Automatic data management across current items, history table, and archive table
- **Efficient Concatenation**: Merge multiple vectors by transferring ownership, not copying data
- **Parallel Transaction Support**: Ready for parallel transactions to speed up data upload
- **Storage Rebates**: Burn old archives to reclaim storage fees and reduce long-term costs
- **Item Updates**: Update existing items in current storage tier
- **Automatic Clamping**: Seamless data migration to history when approaching size limits
- **Binary Search**: O(log n) lookups for historical data

## Module

`endless_vector::endless_vector`

## Quick Start

```move
use endless_vector::endless_vector;

// Create a new endless vector
let mut ev = endless_vector::empty(ctx);

// Push data
endless_vector::push_back(&mut ev, b"Hello");
endless_vector::push_back(&mut ev, b"World");

// Read data
let item0 = endless_vector::get_at(&ev, 0);  // b"Hello"
let item1 = endless_vector::get_at(&ev, 1);  // b"World"

// Get metadata
let len = endless_vector::length(&ev);      // 2
let size = endless_vector::size(&ev);       // 10 (5 + 5 bytes)
```

## Data Structures

### EndlessVector

The main data structure storing the vector and its metadata:

```move
public struct EndlessVector has key {
    id: UID,
    items: vector<vector<u8>>,                      // Current items
    first_item_is_from_previous_history: bool,      // First item continuation flag

    length: u64,                                    // Total items (never decreases)
    binary_length: u64,                             // Total binary size
    this_object_items_binary_length: u64,           // Size of current items

    history: Option<Table<u64, EndlessVectorHistory>>,  // History table
    history_items_count: u64,                       // Number of history entries

    archive: Table<u64, EndlessVectorArchive>,      // Archive table
    archive_items_count: u64,                       // Number of archive entries
    archived_at_length: u64,                        // Length when last archived

    archived_from_length: u64,                      // Start index after burns
    burned_archive_count: u64,                      // Number of burned archives
}
```

### EndlessVectorHistory

Stores historical items moved from the main vector:

```move
public struct EndlessVectorHistory has store, drop {
    items: vector<vector<u8>>,
    followed_by_next_bytes: u64,                    // Bytes from next segment
    first_item_is_from_previous_history: bool,      // Continuation flag
    saved_at_length: u64,                           // Length when saved
}
```

### EndlessVectorArchive

Archives older history entries for long-term storage:

```move
public struct EndlessVectorArchive has store, key {
    id: UID,
    history: Table<u64, EndlessVectorHistory>,
    archived_at_length: u64,                        // Length when archived
    length: u64,                                    // Items in this archive
}
```

## Public Functions

### Creation

#### `empty(ctx: &mut TxContext): EndlessVector`

Creates and returns a new empty EndlessVector.

```move
public fun empty(ctx: &mut TxContext): EndlessVector
```

**Returns:** A new EndlessVector instance

**Example:**
```move
let ev = endless_vector::empty(ctx);
transfer::transfer(ev, tx_context::sender(ctx));
```

#### `empty_entry(ctx: &mut TxContext)`

Entry function that creates a new EndlessVector and transfers it to the sender.

```move
public entry fun empty_entry(ctx: &mut TxContext)
```

**Example:**
```move
// Call from transaction
endless_vector::empty_entry(ctx);
```

#### `empty_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext): EndlessVector`

Creates a new EndlessVector and pushes multiple items to it in one operation.

```move
public fun empty_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext): EndlessVector
```

**Parameters:**
- `items_to_push` - Vector of byte vectors to push to the new EndlessVector
- `ctx` - Transaction context

**Returns:** A new EndlessVector with items pushed

**Example:**
```move
let mut items = vector::empty<vector<u8>>();
vector::push_back(&mut items, b"Item 1");
vector::push_back(&mut items, b"Item 2");
vector::push_back(&mut items, b"Item 3");

let ev = endless_vector::empty_and_push(items, ctx);
transfer::transfer(ev, tx_context::sender(ctx));
```

#### `empty_entry_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext)`

Entry function wrapper that creates a new EndlessVector with initial items and transfers it to the sender.

```move
public entry fun empty_entry_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext)
```

**Parameters:**
- `items_to_push` - Vector of byte vectors to push to the new EndlessVector
- `ctx` - Transaction context

### Reading

#### `length(endless_v: &EndlessVector): u64`

Returns the total number of items in the vector (including history and archive).

```move
public fun length(endless_v: &EndlessVector): u64
```

**Returns:** Total number of items

#### `size(endless_v: &EndlessVector): u64`

Returns the total binary size of all items in bytes.

```move
public fun size(endless_v: &EndlessVector): u64
```

**Returns:** Total binary length in bytes

#### `has_items_from(endless_v: &EndlessVector): u64`

Returns the starting index (offset by burned archives).

```move
public fun has_items_from(endless_v: &EndlessVector): u64
```

**Returns:** Starting index after burned archives

#### `get_at(endless_v: &EndlessVector, i: u64): vector<u8>`

Retrieves an item at the specified index. Automatically searches across all storage tiers.

```move
public fun get_at(endless_v: &EndlessVector, i: u64): vector<u8>
```

**Parameters:**
- `i` - Zero-based index of the item to retrieve

**Returns:** The byte vector at the specified index

**Aborts:**
- If index is out of bounds
- If archive has been burned (with `EArchiveHasBeenBurned`)

**Example:**
```move
let item = endless_vector::get_at(&ev, 0);
assert!(item == b"Hello", 0);
```

### Writing

#### `push_back(endless_v: &mut EndlessVector, bytes: vector<u8>)`

Pushes a new byte vector to the end. Automatically triggers clamping if size limits are approached.

```move
public fun push_back(endless_v: &mut EndlessVector, bytes: vector<u8>)
```

**Parameters:**
- `endless_v` - Mutable reference to the EndlessVector
- `bytes` - Byte vector to push

**Constraints:**
- Maximum chunk size: ~200KB (`SAFE_INNER_SIZE`)
- Aborts with `EChunkIsTooLarge` if exceeded

**Example:**
```move
endless_vector::push_back(&mut ev, b"New item");
```

#### `compose_and_push_back(endless_v: &mut EndlessVector, bytes1-10: vector<u8>)`

Pushes large data by composing up to 10 chunks. Workaround for Sui's argument size limits.

```move
public fun compose_and_push_back(
    endless_v: &mut EndlessVector,
    bytes1: vector<u8>, bytes2: vector<u8>, bytes3: vector<u8>,
    bytes4: vector<u8>, bytes5: vector<u8>, bytes6: vector<u8>,
    bytes7: vector<u8>, bytes8: vector<u8>, bytes9: vector<u8>,
    bytes10: vector<u8>
)
```

**Purpose:** Sui has a `max_pure_argument_size` of ~16KB, so each argument can be ~12KB. This function allows pushing up to 10 × 12KB = ~120KB per transaction.

**Parameters:**
- `endless_v` - Mutable reference to the EndlessVector
- `bytes1` to `bytes10` - Up to 10 byte vectors to compose and push (empty vectors are ignored)

**Example:**
```move
let chunk1 = vector::empty<u8>();
let chunk2 = vector::empty<u8>();
// ... fill chunks with data ...

endless_vector::compose_and_push_back(
    &mut ev, chunk1, chunk2, chunk3, chunk4, chunk5,
    chunk6, chunk7, chunk8, chunk9, chunk10
);
```

#### `update_at(endless_v: &mut EndlessVector, i: u64, new_bytes: vector<u8>)`

Updates an existing item at the specified index.

```move
public fun update_at(endless_v: &mut EndlessVector, i: u64, new_bytes: vector<u8>)
```

**Parameters:**
- `endless_v` - Mutable reference to the EndlessVector
- `i` - Zero-based index of the item to update
- `new_bytes` - New byte vector to replace the existing item

**Constraints:**
- New item size cannot exceed `SAFE_INNER_SIZE` (~200KB)
- Can only update items in current storage (not in history or archive)

**Aborts:**
- `EChunkIsTooLarge` if new item is too large
- `EUpdateIndexOutOfBounds` if index is out of bounds
- `EUpdateIndexIsInHistory` if trying to update historical item

**Example:**
```move
endless_vector::update_at(&mut ev, 0, b"Updated item");
```

### Concatenation

#### `concat(endless_v: &mut EndlessVector, other: EndlessVector)`

Concatenates another EndlessVector into this one by transferring ownership of internal structures. The other vector is consumed (destroyed) in the process.

```move
public fun concat(endless_v: &mut EndlessVector, other: EndlessVector)
```

**Parameters:**
- `endless_v` - The target EndlessVector to append to
- `other` - The EndlessVector to concatenate (will be consumed)

**Restrictions:**
- Cannot concatenate vectors that have archived items (aborts with `ECannotConcatWithArchivedItems`)

**Behavior:**
- Efficiently transfers all items, history, and metadata from `other` to `endless_v`
- No item-by-item copying (transfers ownership)
- Properly handles continuation flags across vector boundaries
- All items from `other` are appended to `endless_v` in order

**Example:**
```move
let mut ev1 = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev1, b"Item 1");

let mut ev2 = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev2, b"Item 2");

endless_vector::concat(&mut ev1, ev2);
// ev1 now contains both items, ev2 is destroyed
```

#### `append(endless_v: &mut EndlessVector, others: vector<EndlessVector>)`

Concatenates multiple EndlessVectors into this one. Processes vectors in order.

```move
public fun append(endless_v: &mut EndlessVector, others: vector<EndlessVector>)
```

**Parameters:**
- `endless_v` - The target EndlessVector to append to
- `others` - Vector of EndlessVectors to concatenate (all will be consumed)

**Example:**
```move
let mut ev1 = endless_vector::empty(ctx);
let ev2 = endless_vector::empty(ctx);
let ev3 = endless_vector::empty(ctx);

let mut others = vector::empty<EndlessVector>();
vector::push_back(&mut others, ev2);
vector::push_back(&mut others, ev3);

endless_vector::append(&mut ev1, others);
// ev1 now contains all items from ev1, ev2, and ev3
```

### Archive Management & Storage Rebates

The EndlessVector provides built-in storage management to optimize costs over time. As vectors grow, older data can be archived and eventually burned to reclaim storage rebates.

#### Storage Management Strategy

1. **Active Usage Phase**: New items are pushed and stored in the current items vector
2. **History Phase**: When size limits are approached, items are automatically moved to history table
3. **Archive Phase**: Call `archive()` to move all history to a separate archive object
4. **Burn Phase**: Call `burn_archive()` to permanently delete the oldest archive and reclaim storage rebate

#### `archive(endless_v: &mut EndlessVector, ctx: &mut TxContext)`

Moves all history items to a new archive. Creates a new archive entry and resets the history table.

```move
public fun archive(endless_v: &mut EndlessVector, ctx: &mut TxContext)
```

**Use case:** When history grows too large (e.g., reaches thousands of entries), archive it to:
- Maintain optimal performance for recent data access
- Prepare old data for eventual burning and storage rebate recovery
- Separate active data from historical data

**Example:**
```move
endless_vector::archive(&mut ev, ctx);
```

#### `burn_archive(endless_v: &mut EndlessVector)`

Permanently deletes the oldest archive and recovers storage rebate. Updates `archived_from_length` and `burned_archive_count`.

```move
public fun burn_archive(endless_v: &mut EndlessVector)
```
**Warning:** This is irreversible. Old data will be permanently lost and cannot be retrieved.

**Use case:**
- Reclaim storage fees for old data you no longer need
- Implement data retention policies (e.g., keep only last 6 months of data)
- Reduce ongoing storage costs for perpetually growing datasets

**Example:**
```move
endless_vector::burn_archive(&mut ev);
```

#### `flush(endless_v: &mut EndlessVector)`

Clears all data from the vector, including history and archives. Resets all counters to zero.

```move
public fun flush(endless_v: &mut EndlessVector)
```

**Warning:** This is irreversible and deletes all data.

**Example:**
```move
endless_vector::flush(&mut ev);
```

## Constants

```move
const SAFE_INNER_SIZE: u64 = 200*1024;  // 200KB safe size for inner storage
```

**Rationale:**
- Sui's `max_move_object_size` is 250KB
- Sui's `max_tx_size_bytes` is 128KB
- Safe inner size is 200KB to respect both limits with overhead
- Allows pushing items up to ~200KB each

## Error Codes

```move
const EChunkIsTooLarge: u64 = 91;                    // Chunk exceeds SAFE_INNER_SIZE
const EArchiveHasBeenBurned: u64 = 92;               // Attempted access to burned archive
const EUpdateIndexOutOfBounds: u64 = 93;             // Update index out of bounds
const EUpdateSizeExceedsLimit: u64 = 94;             // Updated item exceeds size limit
const EUpdateIndexIsInHistory: u64 = 95;             // Cannot update historical items
const EUpdateItemsVectorIsEmpty: u64 = 96;           // Items vector is empty
const ECannotConcatWithArchivedItems: u64 = 97;      // Cannot concat with archived items
```

## Storage Architecture

The contract uses a three-tier storage system to overcome Sui's object size constraints:

### Tier 1: Items Vector
- Most recent data stored directly in `items: vector<vector<u8>>`
- Fast access, limited by object size constraints
- When approaching `SAFE_INNER_SIZE`, data is "clamped" to history

### Tier 2: History Table
- Older data moved from items vector
- Stored in `history: Option<Table<u64, EndlessVectorHistory>>`
- Uses binary search for efficient lookups
- Multiple history segments with continuation flags for items split across boundaries

### Tier 3: Archive Table
- Historical data archived for long-term storage
- Stored in `archive: Table<u64, EndlessVectorArchive>`
- Each archive contains a snapshot of the history table
- Can be burned (deleted) to manage storage costs

## Internal Mechanisms

### Clamping

When `push_back` would exceed `SAFE_INNER_SIZE`, the `clamp` function:
1. Moves current items to a new history entry
2. Handles item splitting if the last item spans boundaries
3. Updates counters and flags
4. Clears the items vector for new data

### Item Splitting

Large items that would be split across storage boundaries are handled through:
- `followed_by_next_bytes`: Tracks continuation size
- `first_item_is_from_previous_history`: Marks continuation items
- Automatic reassembly during `get_at`

This ensures seamless access to large items regardless of storage boundaries.

### Binary Search

The contract uses binary search to efficiently locate items in history:
- Searches by `saved_at_length` field
- O(log n) complexity for history lookups
- Handles both archived and current history

### Concatenation Implementation

The `concat` function efficiently merges vectors:
- Transfers ownership of history items and internal structures
- Uses direct `vector::push_back` to avoid double-counting
- Properly adjusts `saved_at_length` values in transferred history items
- Handles continuation flags across vector boundaries

## Building

```bash
sui move build
```

Build with unpublished dependencies:
```bash
sui move build --with-unpublished-dependencies
```

## Testing

The contract includes comprehensive unit tests using the Sui test framework:
With custom gas limit for complex tests:
```bash
sui move test --gas-limit=9999999999999999
```

Tests cover:
- Basic push and get operations
- Large data handling (30KB, 99KB items)
- Concatenation of multiple vectors
- Archive and burn operations
- Item updates
- Edge cases and error conditions

Tests are marked with `#[test]` and use:
- `sui::test_scenario` for transaction simulation
- `std::debug` for debugging output

## Usage Examples

### Basic Operations

```move
use endless_vector::endless_vector;

// Create and populate
let mut ev = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev, b"Hello");
endless_vector::push_back(&mut ev, b"World");

// Read data
let item0 = endless_vector::get_at(&ev, 0);  // b"Hello"
let len = endless_vector::length(&ev);       // 2
```

### Creating with Initial Data

```move
let mut items = vector::empty<vector<u8>>();
vector::push_back(&mut items, b"Item 1");
vector::push_back(&mut items, b"Item 2");
vector::push_back(&mut items, b"Item 3");

let ev = endless_vector::empty_and_push(items, ctx);
```

### Concatenating Vectors

```move
// Create multiple vectors
let mut ev1 = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev1, b"Vector 1 - Item 1");
endless_vector::push_back(&mut ev1, b"Vector 1 - Item 2");

let mut ev2 = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev2, b"Vector 2 - Item 1");
endless_vector::push_back(&mut ev2, b"Vector 2 - Item 2");

let mut ev3 = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev3, b"Vector 3 - Item 1");

// Concat single vector
endless_vector::concat(&mut ev1, ev2);

// Or append multiple at once
let mut others = vector::empty<EndlessVector>();
vector::push_back(&mut others, ev3);
endless_vector::append(&mut ev1, others);

// ev1 now contains all 5 items
```

### Updating Items

```move
let mut ev = endless_vector::empty(ctx);
endless_vector::push_back(&mut ev, b"Original");

// Update the item
endless_vector::update_at(&mut ev, 0, b"Updated");

let item = endless_vector::get_at(&ev, 0);
assert!(item == b"Updated", 0);
```

### Archive Management

```move
// After many pushes, archive old data
endless_vector::archive(&mut ev, ctx);

// Later, burn old archives to save storage
endless_vector::burn_archive(&mut ev);
```

## License

Apache-2.0

## Repository

https://github.com/fizzyFlow/endless_vector

## Author

[suidouble](https://github.com/suidouble)
