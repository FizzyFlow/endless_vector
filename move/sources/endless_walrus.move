module endless_vector::endless_walrus {
    const VERSION: u64 = 3;

    const SAFE_INNER_SIZE: u64 = 128*1024;  // Keep in object.items, more in history/archive

    // Walrus charges storage per "unit" of 1 MiB; mirrors `BYTES_PER_UNIT_SIZE` in
    // walrus::system_state_inner. Cost = ceil(storage_size / unit) * price_per_unit * epochs.
    const BYTES_PER_UNIT_SIZE: u64 = 1_024 * 1_024;

    use sui::table::{Self, Table};
    use sui::coin::Coin;

    use endless_vector::endless_walrus_item::{
        Self as item,
        EndlessWalrusItem,
    };
    use walrus::blob::{Self, Blob};
    use walrus::system::System;
    use walrus::storage_resource;
    use wal::wal::WAL;

    const EChunkIsTooLarge: u64 = 91;
    const EArchiveHasBeenBurned: u64 = 92;
    const ECannotUpdateArchivedItem: u64 = 93;
    const ESizeExceedsLimit: u64 = 94;
    const ECannotUpdateSplitItem: u64 = 95;
    const EIndexOutOfBounds: u64 = 96;
    const ECannotConcatWithArchivedItems: u64 = 97;
    const EUnexpectedLength: u64 = 98;
    const ENotABytesItem: u64 = 100;
    const ENotABlobItem: u64 = 101;
    const EIdMismatch: u64 = 102;
    const ESealKeyAlreadySet: u64 = 103;
    const ECannotConcatSealedVector: u64 = 104;

    public struct EndlessWalrusVector has key, store {
        id: UID,
        items: vector<EndlessWalrusItem>,
        first_item_is_from_previous_history: bool, // if the first item should be appended to the last one from the previous EndlessWalrusHistory

        length: u64,    // total number of items, including those in history and archive, this value can not decrease
        binary_length: u64, // total binary length of all items, including those in history and archive, this value can not decrease
        this_object_items_binary_length: u64, // total binary length (item_binary_length) of .items stored directly in this object ( without Tables )
        this_object_storage_volume: u64, // total storage bytes (item_storage_volume) of .items stored directly in this object; blobs contribute 0

        history: Option<Table<u64, EndlessWalrusHistory>>, // history of items that were in .items but got clamped ( to fit into object size limits )
        history_items_count: u64,

        archive: Table<u64, EndlessWalrusArchive>, // archive of history items that were in .history but got archived ( to speed up access to recent items )
        archive_items_count: u64,
        archived_at_length: u64,    // EndlessWalrusVector.length value at which the last archive was created

        archived_from_length: u64,   // in case start of the archive has been burned,
        burned_archive_count: u64,    // how many archive items have been burned from the start of the archive

        made_with_version: u64, // version of the module when this EndlessWalrusVector was created
        meta: vector<u8>, // just in case we need to store some extra info in the future

        // Seal-encrypted AES key for layered encryption. Set once via `set_seal_encrypted_key`.
        // When `some`, SDKs MUST encrypt every pushed item with the wrapped AES key and decrypt on read.
        // Scope is the vector's object id; see `seal_approve_endless_vector_owner`.
        seal_encrypted_key: Option<vector<u8>>,
    }

    // EndlessWalrusHistory cannot have `drop` because EndlessWalrusItem has no `drop`.
    public struct EndlessWalrusHistory has store {
        items: vector<EndlessWalrusItem>,
        followed_by_next_bytes: u64,               // last item is truncated and followed by the N byes from the first item of the next EndlessWalrusHistory
        first_item_is_from_previous_history: bool, // if the first item should be appended to the last one from the previous EndlessWalrusHistory
        saved_at_length: u64,
        storage_volume: u64,                       // cached sum of item_storage_volume over `items` (kept in sync on every mutation)
    }

    public struct EndlessWalrusArchive has store, key {
        id: UID,
        history: Table<u64, EndlessWalrusHistory>,
        archived_at_length: u64,    // EndlessWalrusVector.length value at which this archive was created
        length: u64,      // total number of items in this archive
    }

    // ======================================================================
    // Internal helpers for working with non-droppable items in vectors/tables
    // ======================================================================

    /// Replace the item at `idx` with `new_item`, returning the old item.
    fun swap_item_in_vec(v: &mut vector<EndlessWalrusItem>, idx: u64, new_item: EndlessWalrusItem): EndlessWalrusItem {
        let len = vector::length(v);
        vector::push_back(v, new_item);
        vector::swap(v, idx, len);
        vector::pop_back(v)
    }

    /// Drain `from` into `into` (preserves order). `from` is destroyed.
    fun drain_items_into(into: &mut vector<EndlessWalrusItem>, mut from: vector<EndlessWalrusItem>) {
        vector::reverse(&mut from);
        while (!vector::is_empty(&from)) {
            vector::push_back(into, vector::pop_back(&mut from));
        };
        vector::destroy_empty(from);
    }

    /// Burn all items in a vector (consumes the vector).
    fun burn_items_vec(mut v: vector<EndlessWalrusItem>) {
        while (!vector::is_empty(&v)) {
            item::burn_item(vector::pop_back(&mut v));
        };
        vector::destroy_empty(v);
    }

    /// Burn a history segment (its items and then destructure).
    fun burn_history_segment(seg: EndlessWalrusHistory) {
        let EndlessWalrusHistory { items: items_v, followed_by_next_bytes: _, first_item_is_from_previous_history: _, saved_at_length: _, storage_volume: _ } = seg;
        burn_items_vec(items_v);
    }

    /// Burn an archive item (its history segments and then destructure).
    fun burn_archive_item(arch: EndlessWalrusArchive) {
        let EndlessWalrusArchive { id, mut history, archived_at_length: _, length: _ } = arch;
        let mut i = 0;
        let n = table::length(&history);
        while (i < n) {
            let seg = table::remove(&mut history, i);
            burn_history_segment(seg);
            i = i + 1;
        };
        table::destroy_empty(history);
        sui::object::delete(id);
    }

    // ======================================================================
    // Constructors
    // ======================================================================

    #[allow(lint(self_transfer))]
    public fun transfer_to_sender(endless_v: EndlessWalrusVector, ctx: &mut TxContext) {
        transfer::public_transfer(endless_v, ctx.sender());
    }

    #[allow(lint(self_transfer))]
    public fun empty_entry(ctx: &mut TxContext) {
        let endless_vector = empty(ctx);
        transfer::transfer(endless_vector, ctx.sender());
    }

    /// Seal policy: grants access iff the PTB sender owns `EndlessWalrusVector`.
    /// The `id` is the vector's 32-byte object address — used by Seal IBE to derive
    /// a resource-specific key; the Move code does not validate it.
    public fun seal_approve_endless_vector_owner(id: vector<u8>, ev: &EndlessWalrusVector, _ctx: &TxContext) {
        assert!(object::uid_to_bytes(&ev.id) == id, EIdMismatch);
    }

    public fun empty(ctx: &mut TxContext): EndlessWalrusVector {
        EndlessWalrusVector {
            id: object::new(ctx),

            items: vector::empty(),
            first_item_is_from_previous_history: false,
            length: 0,
            binary_length: 0,
            this_object_items_binary_length: 0,
            this_object_storage_volume: 0,

            history: std::option::some(table::new(ctx)),
            history_items_count: 0,

            archive: table::new(ctx),
            archive_items_count: 0,
            archived_at_length: 0,

            archived_from_length: 0,
            burned_archive_count: 0,

            made_with_version: VERSION,
            meta: vector::empty<u8>(),

            seal_encrypted_key: std::option::none(),
        }
    }

    /// Attach a Seal-encrypted AES key to this vector. Settable once.
    /// After this, the vector is considered "sealed" and SDKs must encrypt every push.
    public fun set_seal_encrypted_key(ev: &mut EndlessWalrusVector, key: vector<u8>) {
        assert!(std::option::is_none(&ev.seal_encrypted_key), ESealKeyAlreadySet);
        ev.seal_encrypted_key = std::option::some(key);
    }

    /// Borrow the Seal-encrypted AES key (or `none` if vector is unsealed).
    public fun seal_encrypted_key(ev: &EndlessWalrusVector): &Option<vector<u8>> {
        &ev.seal_encrypted_key
    }

    /// True iff this vector has a Seal-encrypted AES key attached.
    public fun is_sealed(ev: &EndlessWalrusVector): bool {
        std::option::is_some(&ev.seal_encrypted_key)
    }

    /**
        Creates a new EndlessWalrusVector and pushes multiple items to it.
        Returns the EndlessWalrusVector with all items pushed.
    */
    public fun empty_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext): EndlessWalrusVector {
        let mut endless_v = empty(ctx);
        let mut to_push = items_to_push;
        vector::reverse(&mut to_push);
        while (!vector::is_empty(&to_push)) {
            let bytes = vector::pop_back(&mut to_push);
            push_back_bytes(&mut endless_v, bytes);
        };
        vector::destroy_empty(to_push);

        endless_v
    }

    /**
        Creates a new EndlessWalrusVector, pushes multiple items to it, and transfers it to the sender.
        Entry function wrapper around empty_and_push.
    */
    #[allow(lint(self_transfer))]
    public fun empty_entry_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext) {
        let endless_v = empty_and_push(items_to_push, ctx);
        transfer::transfer(endless_v, ctx.sender());
    }

    /**
        Concatenates all items from the second EndlessWalrusVector to the first one by transferring
        history, and current items directly without copying item by item.
        The second vector will be consumed (destroyed) in the process.
    */
    public fun concat(endless_v: &mut EndlessWalrusVector, other: EndlessWalrusVector) {
        // Sealed vectors hold items encrypted under per-vector AES keys; merging two
        // would require re-encrypting every item under one key. Not supported.
        assert!(std::option::is_none(&endless_v.seal_encrypted_key), ECannotConcatSealedVector);
        assert!(std::option::is_none(&other.seal_encrypted_key), ECannotConcatSealedVector);

        let EndlessWalrusVector {
            id: other_id,
            items: other_items,
            first_item_is_from_previous_history: other_first_item_is_from_previous_history,
            length: other_length,
            binary_length: other_binary_length,
            this_object_items_binary_length: _,
            this_object_storage_volume: _,
            history: other_history,
            history_items_count: other_history_items_count,
            archive: other_archive,
            archive_items_count: other_archive_items_count,
            archived_at_length: _,
            archived_from_length: _,
            burned_archive_count: _,
            made_with_version: _,
            meta: _,
            seal_encrypted_key: _,
        } = other;

        // Cannot concat with a vector that has archived items
        if (other_archive_items_count > 0) {
            abort ECannotConcatWithArchivedItems
        };

        // Save the original length and binary_length before any modifications
        let original_length = endless_v.length;
        let original_binary_length = endless_v.binary_length;

        // First, move current items from endless_v to history if needed
        if (vector::length(&endless_v.items) > 0) {
            clamp(endless_v, std::option::none());
        };

        // Transfer all history items from other to endless_v
        if (std::option::is_some(&other_history)) {
            let mut other_history_table = std::option::destroy_some(other_history);
            let mut history_idx = 0;
            while (history_idx < other_history_items_count) {
                let mut history_item: EndlessWalrusHistory = table::remove(&mut other_history_table, history_idx);
                // Adjust the saved_at_length to account for the offset (use original_length)
                history_item.saved_at_length = history_item.saved_at_length + original_length;

                if (std::option::is_none(&endless_v.history)) {
                    abort 99 // should never happen, but just in case
                };

                table::add(std::option::borrow_mut(&mut endless_v.history), endless_v.history_items_count, history_item);
                endless_v.history_items_count = endless_v.history_items_count + 1;
                history_idx = history_idx + 1;
            };
            table::destroy_empty(other_history_table);
        } else {
            std::option::destroy_none(other_history);
        };

        // Compute deltas, then drain other.items into endless_v.items.
        let mut other_items_storage_volume = 0u64;
        let mut other_items_binary_length = 0u64;
        let mut idx = 0;
        let n = vector::length(&other_items);
        while (idx < n) {
            let it_ref = vector::borrow(&other_items, idx);
            other_items_storage_volume = other_items_storage_volume + item::item_storage_volume(it_ref);
            other_items_binary_length = other_items_binary_length + item::item_binary_length(it_ref);
            idx = idx + 1;
        };

        let other_items_len = n;
        drain_items_into(&mut endless_v.items, other_items);

        // Update tracking fields
        endless_v.this_object_storage_volume = endless_v.this_object_storage_volume + other_items_storage_volume;
        endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + other_items_binary_length;

        // Handle first_item_is_from_previous_history flag
        if (other_first_item_is_from_previous_history && other_items_len > 0) {
            endless_v.first_item_is_from_previous_history = true;
        };

        // Update total length and binary length
        endless_v.length = original_length + other_length;
        endless_v.binary_length = original_binary_length + other_binary_length;

        // Clean up other's archive table (should be empty now) and id
        table::destroy_empty(other_archive);
        object::delete(other_id);
    }

    /**
        Appends multiple EndlessWalrusVectors to the target by concatenating them one by one.
        Each EndlessWalrusVector in the others array will be consumed (destroyed) in the process.
    */
    public fun append(endless_v: &mut EndlessWalrusVector, mut others: vector<EndlessWalrusVector>) {
        vector::reverse(&mut others);

        while (!vector::is_empty(&others)) {
            let other = vector::pop_back(&mut others);
            concat(endless_v, other);
        };

        vector::destroy_empty(others);
    }

    public fun length(endless_v: &EndlessWalrusVector): u64 {
        endless_v.length
    }

    public fun size(endless_v: &EndlessWalrusVector): u64 {
        endless_v.binary_length
    }

    /// Assert that the vector's current length equals `expected`.
    /// Place this as the first command in a PTB before push_back so the entire
    /// transaction aborts atomically if a concurrent or already-landed push has
    /// changed the length. Takes an immutable borrow — no state is modified.
    public fun ensure_length(endless_v: &EndlessWalrusVector, expected: u64) {
        assert!(endless_v.length == expected, EUnexpectedLength);
    }

    public fun has_items_from(endless_v: &EndlessWalrusVector): u64 {
        endless_v.archived_from_length
    }

    public fun history_items_count(endless_v: &EndlessWalrusVector): u64 {
        endless_v.history_items_count
    }

    public fun archive_items_count(endless_v: &EndlessWalrusVector): u64 {
        endless_v.archive_items_count
    }

    // ======================================================================
    // Walrus blob storage lifetime: inspect & extend
    // ======================================================================

    /// Fold the minimum blob `end_epoch` over a vector of items into `min`.
    fun fold_min_blob_end_epoch(items: &vector<EndlessWalrusItem>, min: &mut Option<u32>) {
        let n = vector::length(items);
        let mut i = 0;
        while (i < n) {
            let it = vector::borrow(items, i);
            if (item::item_has_blob(it)) {
                let end = blob::end_epoch(item::item_borrow_blob(it));
                if (std::option::is_none(min) || end < *std::option::borrow(min)) {
                    *min = std::option::some(end);
                };
            };
            i = i + 1;
        };
    }

    /// Minimum `end_epoch` across every Blob held by this vector
    /// (.items + history segments + non-burned archive segments).
    /// Returns `none` if the vector holds no blobs.
    public fun min_blob_end_epoch(endless_v: &EndlessWalrusVector): Option<u32> {
        let mut min = std::option::none<u32>();

        fold_min_blob_end_epoch(&endless_v.items, &mut min);

        // History segments.
        if (std::option::is_some(&endless_v.history)) {
            let history = std::option::borrow(&endless_v.history);
            let mut k = 0;
            while (k < endless_v.history_items_count) {
                fold_min_blob_end_epoch(&table::borrow(history, k).items, &mut min);
                k = k + 1;
            };
        };

        // Non-burned archive segments.
        let mut a = endless_v.burned_archive_count;
        while (a < endless_v.archive_items_count) {
            let arch = table::borrow(&endless_v.archive, a);
            let seg_count = table::length(&arch.history);
            let mut h = 0;
            while (h < seg_count) {
                fold_min_blob_end_epoch(&table::borrow(&arch.history, h).items, &mut min);
                h = h + 1;
            };
            a = a + 1;
        };

        min
    }

    /// Extend, for every blob item in `items`, the storage so it reaches `target_end_epoch`.
    /// Blobs already valid through the target are skipped; expired blobs (which Walrus cannot
    /// extend) are skipped.
    fun extend_items_to_epoch(
        items: &mut vector<EndlessWalrusItem>,
        walrus_system: &mut System,
        current_epoch: u32,
        target_end_epoch: u32,
        payment: &mut Coin<WAL>,
    ) {
        let n = vector::length(items);
        let mut i = 0;
        while (i < n) {
            let it = vector::borrow_mut(items, i);
            if (item::item_has_blob(it)) {
                let blob_ref = item::item_borrow_blob_mut(it);
                let end = blob::end_epoch(blob_ref);
                if (end < target_end_epoch && current_epoch < end) {
                    walrus::system::extend_blob(
                        walrus_system,
                        blob_ref,
                        target_end_epoch - end,
                        payment,
                    );
                };
            };
            i = i + 1;
        };
    }

    /// Extend every Blob whose storage ends before `target_end_epoch` so it reaches
    /// `target_end_epoch`, in a single call. Blobs already valid through the target are
    /// skipped; expired blobs (current_epoch >= end_epoch, which Walrus cannot extend) are
    /// skipped. Covers .items + history segments + non-burned archive segments.
    public fun extend_blobs_to_epoch(
        endless_v: &mut EndlessWalrusVector,
        walrus_system: &mut System,
        target_end_epoch: u32,
        payment: &mut Coin<WAL>,
    ) {
        let current_epoch = walrus::system::epoch(walrus_system);

        extend_items_to_epoch(&mut endless_v.items, walrus_system, current_epoch, target_end_epoch, payment);

        // History segments.
        if (std::option::is_some(&endless_v.history)) {
            let mut k = 0;
            while (k < endless_v.history_items_count) {
                let seg = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), k);
                extend_items_to_epoch(&mut seg.items, walrus_system, current_epoch, target_end_epoch, payment);
                k = k + 1;
            };
        };

        // Non-burned archive segments.
        let mut a = endless_v.burned_archive_count;
        while (a < endless_v.archive_items_count) {
            let arch = table::borrow_mut(&mut endless_v.archive, a);
            let seg_count = table::length(&arch.history);
            let mut h = 0;
            while (h < seg_count) {
                let seg = table::borrow_mut(&mut arch.history, h);
                extend_items_to_epoch(&mut seg.items, walrus_system, current_epoch, target_end_epoch, payment);
                h = h + 1;
            };
            a = a + 1;
        };
    }

    public entry fun extend_blobs_to_epoch_entry(
        endless_v: &mut EndlessWalrusVector,
        walrus_system: &mut System,
        target_end_epoch: u32,
        payment: &mut Coin<WAL>,
    ) {
        extend_blobs_to_epoch(endless_v, walrus_system, target_end_epoch, payment);
    }

    /// WAL cost to extend a single blob item up to `target_end_epoch`, mirroring the
    /// charge in walrus::system_state_inner::extend_blob: for each epoch in the extension,
    /// `ceil(storage_size / 1MiB) * storage_price_per_unit_size`. Returns 0 for non-blob
    /// items, blobs already valid through the target, and expired blobs (which are skipped).
    fun blob_extend_cost(it: &EndlessWalrusItem, current_epoch: u32, target_end_epoch: u32, price_per_unit: u64): u64 {
        if (!item::item_has_blob(it)) {
            return 0
        };
        let blob_ref = item::item_borrow_blob(it);
        let end = blob::end_epoch(blob_ref);
        if (end >= target_end_epoch || current_epoch >= end) {
            return 0
        };
        let storage_size = storage_resource::size(blob::storage(blob_ref));
        // ceil(storage_size / BYTES_PER_UNIT_SIZE)
        let storage_units = (storage_size + BYTES_PER_UNIT_SIZE - 1) / BYTES_PER_UNIT_SIZE;
        let epochs = ((target_end_epoch - end) as u64);
        storage_units * price_per_unit * epochs
    }

    /// Sum `blob_extend_cost` over a vector of items into `acc`.
    fun fold_extend_cost_over_items(items: &vector<EndlessWalrusItem>, current_epoch: u32, target_end_epoch: u32, price_per_unit: u64, acc: &mut u64) {
        let n = vector::length(items);
        let mut i = 0;
        while (i < n) {
            *acc = *acc + blob_extend_cost(vector::borrow(items, i), current_epoch, target_end_epoch, price_per_unit);
            i = i + 1;
        };
    }

    /// Total WAL (in FROST) required to bring every blob in this vector up to
    /// `target_end_epoch` via `extend_blobs_to_epoch`. Covers items + history segments +
    /// non-burned archive segments. Read off-chain via transaction simulation (devInspect)
    /// to fund the payment coin exactly. Returns 0 if nothing needs extending.
    ///
    /// `price_per_unit` is the system's `storage_price_per_unit_size` — the on-chain getter
    /// is test-only, so callers pass the value read off-chain (e.g. WalrusClient.systemState).
    /// `current_epoch` comes from the public `system::epoch`.
    public fun extend_blobs_cost_to_epoch(endless_v: &EndlessWalrusVector, walrus_system: &System, target_end_epoch: u32, price_per_unit: u64): u64 {
        let current_epoch = walrus::system::epoch(walrus_system);

        let mut total = 0u64;

        fold_extend_cost_over_items(&endless_v.items, current_epoch, target_end_epoch, price_per_unit, &mut total);

        // History segments.
        if (std::option::is_some(&endless_v.history)) {
            let history = std::option::borrow(&endless_v.history);
            let mut k = 0;
            while (k < endless_v.history_items_count) {
                fold_extend_cost_over_items(&table::borrow(history, k).items, current_epoch, target_end_epoch, price_per_unit, &mut total);
                k = k + 1;
            };
        };

        // Non-burned archive segments.
        let mut a = endless_v.burned_archive_count;
        while (a < endless_v.archive_items_count) {
            let arch = table::borrow(&endless_v.archive, a);
            let seg_count = table::length(&arch.history);
            let mut h = 0;
            while (h < seg_count) {
                fold_extend_cost_over_items(&table::borrow(&arch.history, h).items, current_epoch, target_end_epoch, price_per_unit, &mut total);
                h = h + 1;
            };
            a = a + 1;
        };

        total
    }

    public fun archive(endless_v: &mut EndlessWalrusVector, ctx: &mut TxContext) {
        clamp(endless_v, std::option::none()); // move .items to history if any

        let history = std::option::swap(&mut endless_v.history, table::new(ctx));
        let archive_item = EndlessWalrusArchive {
            id: object::new(ctx),
            history: history,
            archived_at_length: endless_v.length,
            length: (endless_v.length - endless_v.archived_at_length)
        };

        table::add(&mut endless_v.archive, endless_v.archive_items_count, archive_item);
        endless_v.archive_items_count = endless_v.archive_items_count + 1;

        endless_v.history_items_count = 0;
        endless_v.archived_at_length = endless_v.length;
    }

    public fun burn_archive(endless_v: &mut EndlessWalrusVector) {
        if (endless_v.archive_items_count > 0) {
            let last_archive_item = table::remove(&mut endless_v.archive, endless_v.burned_archive_count);
            let archive_length = last_archive_item.length;
            burn_archive_item(last_archive_item);

            endless_v.burned_archive_count = endless_v.burned_archive_count + 1;
            endless_v.archived_from_length = endless_v.archived_from_length + archive_length;
        };
    }

    public fun burn(mut endless_v:  EndlessWalrusVector) {
        flush(&mut endless_v);
        let EndlessWalrusVector {
            id,
            items,
            first_item_is_from_previous_history: _,
            length: _,
            binary_length: _,
            this_object_items_binary_length: _,
            this_object_storage_volume: _,
            history: history_opt,
            history_items_count: _,
            archive: archive_table,
            archive_items_count: _,
            archived_at_length: _,
            archived_from_length: _,
            burned_archive_count: _,
            made_with_version: _,
            meta: _,
            seal_encrypted_key: _,
        } = endless_v;

        // After flush, items must be empty.
        vector::destroy_empty(items);

        if (std::option::is_some(&history_opt)) {
            let history_table = std::option::destroy_some(history_opt);
            table::destroy_empty(history_table);
        } else {
            std::option::destroy_none(history_opt);
        };

        table::destroy_empty(archive_table);

        sui::object::delete(id);
    }

    public fun flush(endless_v: &mut EndlessWalrusVector) {
        // Drain current items.
        while (!vector::is_empty(&endless_v.items)) {
            item::burn_item(vector::pop_back(&mut endless_v.items));
        };

        endless_v.first_item_is_from_previous_history = false;
        endless_v.length = 0;
        endless_v.binary_length = 0;
        endless_v.this_object_items_binary_length = 0;
        endless_v.this_object_storage_volume = 0;

        // Drain history segments.
        while (endless_v.history_items_count > 0) {
            let seg = table::remove(std::option::borrow_mut(&mut endless_v.history), endless_v.history_items_count - 1);
            burn_history_segment(seg);
            endless_v.history_items_count = endless_v.history_items_count - 1;
        };

        endless_v.archived_at_length = 0;
        endless_v.archived_from_length = 0;
        endless_v.burned_archive_count = 0;

        // Drain archive items.
        while (endless_v.archive_items_count > 0) {
            let last_archive_item = table::remove(&mut endless_v.archive, endless_v.archive_items_count - 1);
            burn_archive_item(last_archive_item);
            endless_v.archive_items_count = endless_v.archive_items_count - 1;
        };
    }

    /**
        On sui max_pure_argument_size: Some(16 * 1024), ( base64 encoded )
        Means, we can't pass arg larger than ~ 12*1024 bytes
        This workaround allows to pass up to 10*12*1024 bytes per call
        which is more than enough to cover max_tx_size_bytes: Some(128 * 1024) ( remember base64 encoded )
    */
    public fun compose_and_push_back(endless_v: &mut EndlessWalrusVector, bytes1: vector<u8>, bytes2: vector<u8>, bytes3: vector<u8>,
                    bytes4: vector<u8>, bytes5: vector<u8>, bytes6: vector<u8>,
                    bytes7: vector<u8>, bytes8: vector<u8>, bytes9: vector<u8>,
                    bytes10: vector<u8>) {
        let mut bytes = vector::empty<u8>();
        vector::append(&mut bytes, bytes1);
        vector::append(&mut bytes, bytes2);
        vector::append(&mut bytes, bytes3);
        vector::append(&mut bytes, bytes4);
        vector::append(&mut bytes, bytes5);
        vector::append(&mut bytes, bytes6);
        vector::append(&mut bytes, bytes7);
        vector::append(&mut bytes, bytes8);
        vector::append(&mut bytes, bytes9);
        vector::append(&mut bytes, bytes10);

        push_back_bytes(endless_v, bytes);
    }

    /// Primary push_back. Accepts an EndlessWalrusItem.
    public fun push_back(endless_v: &mut EndlessWalrusVector, new_item: EndlessWalrusItem) {
        let item_storage = item::item_storage_volume(&new_item);
        let item_binary = item::item_binary_length(&new_item);

        if (item_storage > SAFE_INNER_SIZE) {
            abort EChunkIsTooLarge
        };

        if (item_storage + endless_v.this_object_storage_volume > SAFE_INNER_SIZE) {
            // Need to clamp; route through clamp(...)
            clamp(endless_v, option::some(new_item));
        } else {
            vector::push_back(&mut endless_v.items, new_item);
            endless_v.this_object_storage_volume = endless_v.this_object_storage_volume + item_storage;
            endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + item_binary;
            endless_v.binary_length = endless_v.binary_length + item_binary;
            endless_v.length = endless_v.length + 1;
        };
    }

    public fun push_back_bytes(endless_v: &mut EndlessWalrusVector, bytes: vector<u8>) {
        push_back(endless_v, item::new_bytes_item(bytes));
    }

    public fun push_back_blob(endless_v: &mut EndlessWalrusVector, blob: Blob) {
        push_back(endless_v, item::new_blob_item(blob));
    }

    /// Returns a reference to the item at logical index `i`.
    /// For split items (head fragment in history, tail in next history segment or items[0]),
    /// this returns a borrow to the head fragment. Use `read_bytes_at` to get the full bytes.
    public fun get_at(endless_v: &EndlessWalrusVector, i: u64): &EndlessWalrusItem {
        // Fast path: no history, get from items directly
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            return get_from_items(endless_v, i)
        };

        // Determine first index that is stored directly in items
        let index_after_history_ends = get_first_not_historied_index(endless_v);

        if (i < index_after_history_ends) {
            if (endless_v.archived_at_length > i) {
                return get_from_archive(endless_v, i)
            };

            return get_from_history(endless_v, i)
        } else {
            if (endless_v.first_item_is_from_previous_history) {
                return get_from_items(endless_v, i - index_after_history_ends + 1)
            } else {
                return get_from_items(endless_v, i - index_after_history_ends)
            }
        }
    }

    /// Reads the full bytes at logical index `i`, assembling split fragments where needed.
    /// Aborts with `ENotABytesItem` if the item at that index is a Blob (or empty without bytes).
    public fun read_bytes_at(endless_v: &EndlessWalrusVector, i: u64): vector<u8> {
        // Fast path: no history.
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            let it = get_from_items(endless_v, i);
            if (!item::item_has_bytes(it)) abort ENotABytesItem;
            return *item::item_borrow_bytes(it)
        };

        let index_after_history_ends = get_first_not_historied_index(endless_v);

        if (i < index_after_history_ends) {
            if (endless_v.archived_at_length > i) {
                return read_bytes_from_archive(endless_v, i)
            };
            return read_bytes_from_history(endless_v, i)
        } else {
            let local = if (endless_v.first_item_is_from_previous_history) {
                i - index_after_history_ends + 1
            } else {
                i - index_after_history_ends
            };
            let it = get_from_items(endless_v, local);
            if (!item::item_has_bytes(it)) abort ENotABytesItem;
            return *item::item_borrow_bytes(it)
        }
    }

    /// Borrow a Blob at logical index `i`. Aborts with `ENotABlobItem` otherwise.
    public fun borrow_blob_at(endless_v: &EndlessWalrusVector, i: u64): &Blob {
        let it = get_at(endless_v, i);
        if (!item::item_has_blob(it)) abort ENotABlobItem;
        item::item_borrow_blob(it)
    }

    /// Replaces the item at logical index `i` with `new_item`. Burns the previous item.
    public fun update_at(endless_v: &mut EndlessWalrusVector, i: u64, new_item: EndlessWalrusItem) {
        // Check if index is out of bounds
        if (i >= endless_v.length) {
            item::burn_item(new_item);
            abort EIndexOutOfBounds
        };

        // Check if index is in archived range
        if (endless_v.archived_at_length > i) {
            item::burn_item(new_item);
            abort ECannotUpdateArchivedItem
        };

        // Fast path: no history
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            update_in_items(endless_v, i, new_item);
            return
        };

        // Determine first index that is stored directly in items
        let index_after_history_ends = get_first_not_historied_index(endless_v);

        if (i < index_after_history_ends) {
            update_in_history(endless_v, i, new_item);
        } else {
            update_in_items(endless_v, i, new_item);
        };
    }

    public fun update_bytes_at(endless_v: &mut EndlessWalrusVector, i: u64, bytes: vector<u8>) {
        update_at(endless_v, i, item::new_bytes_item(bytes));
    }

    fun update_in_items(endless_v: &mut EndlessWalrusVector, global_index: u64, new_item: EndlessWalrusItem) {
        let index_after_history_ends = get_first_not_historied_index(endless_v);

        let local_index = if (endless_v.first_item_is_from_previous_history) {
            global_index - index_after_history_ends + 1
        } else {
            global_index - index_after_history_ends
        };

        if (local_index >= vector::length(&endless_v.items)) {
            item::burn_item(new_item);
            abort EIndexOutOfBounds
        };

        // Check if this is the first item and it's a continuation from previous history
        if (local_index == 0 && endless_v.first_item_is_from_previous_history) {
            item::burn_item(new_item);
            abort ECannotUpdateSplitItem
        };

        let old_storage = item::item_storage_volume(vector::borrow(&endless_v.items, local_index));
        let old_binary = item::item_binary_length(vector::borrow(&endless_v.items, local_index));
        let new_storage = item::item_storage_volume(&new_item);
        let new_binary = item::item_binary_length(&new_item);

        // Storage size check
        if (new_storage > old_storage) {
            let storage_diff = new_storage - old_storage;
            if (endless_v.this_object_storage_volume + storage_diff > SAFE_INNER_SIZE) {
                item::burn_item(new_item);
                abort ESizeExceedsLimit
            };
            endless_v.this_object_storage_volume = endless_v.this_object_storage_volume + storage_diff;
        } else if (new_storage < old_storage) {
            endless_v.this_object_storage_volume = endless_v.this_object_storage_volume - (old_storage - new_storage);
        };

        // Binary length update (global and per-object)
        if (new_binary > old_binary) {
            endless_v.binary_length = endless_v.binary_length + (new_binary - old_binary);
            endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + (new_binary - old_binary);
        } else if (new_binary < old_binary) {
            endless_v.binary_length = endless_v.binary_length - (old_binary - new_binary);
            endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length - (old_binary - new_binary);
        };

        // Swap and burn old
        let old = swap_item_in_vec(&mut endless_v.items, local_index, new_item);
        item::burn_item(old);
    }

    fun update_in_history(endless_v: &mut EndlessWalrusVector, global_index: u64, new_item: EndlessWalrusItem) {
        let history_index = binary_search_history_by_saved_length(endless_v, global_index);

        // Read shape data without holding mutable borrow
        let (local_index, hist_items_len, followed_by_next_bytes, first_item_from_prev) = {
            let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);
            let li = global_index + vector::length(&history_item.items) - history_item.saved_at_length;
            (li,
                vector::length(&history_item.items),
                history_item.followed_by_next_bytes,
                history_item.first_item_is_from_previous_history)
        };

        if (local_index >= hist_items_len) {
            item::burn_item(new_item);
            abort EIndexOutOfBounds
        };

        // Case 1: Last item in this history with continuation bytes (split item)
        if (local_index == hist_items_len - 1 && followed_by_next_bytes > 0) {
            update_split_item_in_history(endless_v, history_index, new_item);
            return
        };

        // Case 2: First item that is from previous history (head fragment lives in prev segment).
        if (local_index == 0 && first_item_from_prev) {
            item::burn_item(new_item);
            abort ECannotUpdateSplitItem
        };

        // Snapshot old sizes
        let (old_storage, old_binary, total_storage_in_segment) = {
            let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);
            let it = vector::borrow(&history_item.items, local_index);
            (item::item_storage_volume(it),
                item::item_binary_length(it),
                history_item.storage_volume)
        };

        let new_storage = item::item_storage_volume(&new_item);
        let new_binary = item::item_binary_length(&new_item);

        // Storage check against SAFE_INNER_SIZE for the segment
        if (new_storage > old_storage) {
            let storage_diff = new_storage - old_storage;
            if (total_storage_in_segment + storage_diff > SAFE_INNER_SIZE) {
                item::burn_item(new_item);
                abort ESizeExceedsLimit
            };
        };

        // Update binary_length
        if (new_binary > old_binary) {
            endless_v.binary_length = endless_v.binary_length + (new_binary - old_binary);
        } else if (new_binary < old_binary) {
            endless_v.binary_length = endless_v.binary_length - (old_binary - new_binary);
        };

        // Swap into the segment, maintaining the cached storage_volume.
        let history_item = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), history_index);
        let old = swap_item_in_vec(&mut history_item.items, local_index, new_item);
        if (new_storage > old_storage) {
            history_item.storage_volume = history_item.storage_volume + (new_storage - old_storage);
        } else if (new_storage < old_storage) {
            history_item.storage_volume = history_item.storage_volume - (old_storage - new_storage);
        };
        item::burn_item(old);
    }

    fun update_split_item_in_history(endless_v: &mut EndlessWalrusVector, history_index: u64, new_item: EndlessWalrusItem) {
        // The old item is bytes (invariant from clamp). The new item must also be bytes.
        if (!item::item_has_bytes(&new_item)) {
            item::burn_item(new_item);
            abort ECannotUpdateSplitItem
        };

        // Pull bytes out of the new item
        let bytes = item::destroy_item_into_bytes(new_item);

        // First, gather information without holding mutable references
        let (old_first_part_size, old_second_part_size, last_index, current_history_total_size) = {
            let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);
            let last_idx = vector::length(&history_item.items) - 1;
            let last_item_ref = vector::borrow(&history_item.items, last_idx);
            // Old head fragment is bytes (invariant)
            let old_first_size = item::item_storage_volume(last_item_ref);
            let old_second_size = history_item.followed_by_next_bytes;
            let total_size = history_item.storage_volume;

            (old_first_size, old_second_size, last_idx, total_size)
        };

        let old_total_size = old_first_part_size + old_second_part_size;
        let new_size = vector::length(&bytes);

        // Calculate size difference for binary_length
        if (new_size > old_total_size) {
            endless_v.binary_length = endless_v.binary_length + (new_size - old_total_size);
        } else if (new_size < old_total_size) {
            endless_v.binary_length = endless_v.binary_length - (old_total_size - new_size);
        };

        // Determine where the continuation is stored
        let continuation_in_next_history = history_index + 1 < endless_v.history_items_count;
        let continuation_in_items = endless_v.first_item_is_from_previous_history && vector::length(&endless_v.items) > 0;

        if (!continuation_in_next_history && !continuation_in_items) {
            abort 0 // No continuation available - should not happen
        };

        // Split the new bytes at the same boundary
        let new_first_part_size = if (new_size <= old_first_part_size) {
            new_size
        } else {
            old_first_part_size
        };

        let mut new_first_part = vector::empty<u8>();
        let mut new_second_part = vector::empty<u8>();

        let mut i = 0;
        while (i < new_size) {
            if (i < new_first_part_size) {
                vector::push_back(&mut new_first_part, *vector::borrow(&bytes, i));
            } else {
                vector::push_back(&mut new_second_part, *vector::borrow(&bytes, i));
            };
            i = i + 1;
        };

        let new_second_part_size = vector::length(&new_second_part);

        // Check segment-size limits
        if (new_first_part_size > old_first_part_size) {
            let first_part_diff = new_first_part_size - old_first_part_size;
            if (current_history_total_size + first_part_diff > SAFE_INNER_SIZE) {
                abort ESizeExceedsLimit
            };
        };

        if (continuation_in_next_history && new_second_part_size > old_second_part_size) {
            let second_part_diff = new_second_part_size - old_second_part_size;
            let next_history_item = table::borrow(std::option::borrow(&endless_v.history), history_index + 1);
            let next_total_size = next_history_item.storage_volume;

            if (next_total_size + second_part_diff > SAFE_INNER_SIZE) {
                abort ESizeExceedsLimit
            };
        };

        // Update the first part in history
        {
            let history_item = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), history_index);
            let new_head_item = item::new_bytes_item(new_first_part);
            let old_head = swap_item_in_vec(&mut history_item.items, last_index, new_head_item);
            if (new_first_part_size > old_first_part_size) {
                history_item.storage_volume = history_item.storage_volume + (new_first_part_size - old_first_part_size);
            } else if (new_first_part_size < old_first_part_size) {
                history_item.storage_volume = history_item.storage_volume - (old_first_part_size - new_first_part_size);
            };
            item::burn_item(old_head);
            history_item.followed_by_next_bytes = new_second_part_size;
        };

        // Now update the second part
        if (continuation_in_next_history) {
            let next_history_item = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), history_index + 1);
            let new_tail_item = item::new_bytes_item(new_second_part);
            let old_tail = swap_item_in_vec(&mut next_history_item.items, 0, new_tail_item);
            if (new_second_part_size > old_second_part_size) {
                next_history_item.storage_volume = next_history_item.storage_volume + (new_second_part_size - old_second_part_size);
            } else if (new_second_part_size < old_second_part_size) {
                next_history_item.storage_volume = next_history_item.storage_volume - (old_second_part_size - new_second_part_size);
            };
            item::burn_item(old_tail);
        } else {
            // Continuation is in current items.
            if (new_second_part_size > old_second_part_size) {
                let second_part_diff = new_second_part_size - old_second_part_size;
                if (endless_v.this_object_storage_volume + second_part_diff > SAFE_INNER_SIZE) {
                    abort ESizeExceedsLimit
                };
                endless_v.this_object_storage_volume = endless_v.this_object_storage_volume + second_part_diff;
                endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + second_part_diff;
            } else if (new_second_part_size < old_second_part_size) {
                let diff = old_second_part_size - new_second_part_size;
                endless_v.this_object_storage_volume = endless_v.this_object_storage_volume - diff;
                endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length - diff;
            };

            let new_tail_item = item::new_bytes_item(new_second_part);
            let old_tail = swap_item_in_vec(&mut endless_v.items, 0, new_tail_item);
            item::burn_item(old_tail);
        };
    }

    fun get_from_items(endless_v: &EndlessWalrusVector, local_index: u64): &EndlessWalrusItem {
        if (local_index >= vector::length(&endless_v.items)) {
            abort 0 // Index out of bounds
        };
        vector::borrow(&endless_v.items, local_index)
    }

    /// Returns a borrow to the head fragment of the item at `global_index` in history.
    fun get_from_history(endless_v: &EndlessWalrusVector, global_index: u64): &EndlessWalrusItem {
        let history_index = binary_search_history_by_saved_length(endless_v, global_index);
        let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);

        let i = global_index + vector::length(&history_item.items) - history_item.saved_at_length;
        vector::borrow(&history_item.items, i)
    }

    fun get_from_archive(endless_v: &EndlessWalrusVector, global_index: u64): &EndlessWalrusItem {
        if (endless_v.burned_archive_count > 0 && global_index < endless_v.archived_from_length) {
            abort EArchiveHasBeenBurned
        };

        let archive_index = binary_search_archive_by_archived_length(endless_v, global_index);
        let archive_item = table::borrow(&endless_v.archive, archive_index);
        let history_index = binary_search_archive_history_by_saved_length(archive_item, global_index);
        let history_item = table::borrow(&archive_item.history, history_index);

        let i = global_index + vector::length(&history_item.items) - history_item.saved_at_length;
        vector::borrow(&history_item.items, i)
    }

    /// Read full bytes for index in history (handles split items).
    fun read_bytes_from_history(endless_v: &EndlessWalrusVector, global_index: u64): vector<u8> {
        let history_index = binary_search_history_by_saved_length(endless_v, global_index);
        let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);

        let i = global_index + vector::length(&history_item.items) - history_item.saved_at_length;

        let head_item = vector::borrow(&history_item.items, i);
        if (!item::item_has_bytes(head_item)) abort ENotABytesItem;

        if (i < vector::length(&history_item.items) - 1 || history_item.followed_by_next_bytes == 0) {
            return *item::item_borrow_bytes(head_item)
        };

        // Split: assemble head + tail
        let mut result = *item::item_borrow_bytes(head_item);

        if (history_index + 1 < endless_v.history_items_count) {
            let next_history = table::borrow(std::option::borrow(&endless_v.history), history_index + 1);
            let tail_item = vector::borrow(&next_history.items, 0);
            if (!item::item_has_bytes(tail_item)) abort ENotABytesItem;
            vector::append(&mut result, *item::item_borrow_bytes(tail_item));
        } else if (endless_v.first_item_is_from_previous_history && vector::length(&endless_v.items) > 0) {
            let tail_item = vector::borrow(&endless_v.items, 0);
            if (!item::item_has_bytes(tail_item)) abort ENotABytesItem;
            vector::append(&mut result, *item::item_borrow_bytes(tail_item));
        } else {
            abort 0 // No continuation available
        };

        result
    }

    fun read_bytes_from_archive(endless_v: &EndlessWalrusVector, global_index: u64): vector<u8> {
        if (endless_v.burned_archive_count > 0 && global_index < endless_v.archived_from_length) {
            abort EArchiveHasBeenBurned
        };

        let archive_index = binary_search_archive_by_archived_length(endless_v, global_index);
        let archive_item = table::borrow(&endless_v.archive, archive_index);
        let history_index = binary_search_archive_history_by_saved_length(archive_item, global_index);
        let history_item = table::borrow(&archive_item.history, history_index);

        let i = global_index + vector::length(&history_item.items) - history_item.saved_at_length;

        let head_item = vector::borrow(&history_item.items, i);
        if (!item::item_has_bytes(head_item)) abort ENotABytesItem;

        if (i < vector::length(&history_item.items) - 1 || history_item.followed_by_next_bytes == 0) {
            return *item::item_borrow_bytes(head_item)
        };

        let mut result = *item::item_borrow_bytes(head_item);

        if (history_index + 1 < table::length(&archive_item.history)) {
            let next_history = table::borrow(&archive_item.history, history_index + 1);
            let tail_item = vector::borrow(&next_history.items, 0);
            if (!item::item_has_bytes(tail_item)) abort ENotABytesItem;
            vector::append(&mut result, *item::item_borrow_bytes(tail_item));
        } else {
            abort 0 // No continuation available within archive
        };

        result
    }

    fun binary_search_archive_by_archived_length(endless_v: &EndlessWalrusVector, target_index: u64): u64 {
        if (endless_v.archive_items_count == 0) {
            abort 0
        };

        let mut left = endless_v.burned_archive_count;
        let mut right = endless_v.archive_items_count - 1;

        while (left <= right) {
            let mid = left + (right - left) / 2;
            let archive_item = table::borrow(&endless_v.archive, mid);

            let archive_start = archive_item.archived_at_length - archive_item.length;
            let archive_end = archive_item.archived_at_length;

            if (target_index >= archive_start && target_index < archive_end) {
                return mid
            } else if (target_index < archive_start) {
                if (mid == 0) break;
                right = mid - 1;
            } else {
                left = mid + 1;
            };

            if (right == 0 && left > right) {
                break
            };
        };

        abort 0
    }

    fun binary_search_archive_history_by_saved_length(archive: &EndlessWalrusArchive, target_index: u64): u64 {
        let history_count = table::length(&archive.history);

        if (history_count == 0) {
            abort 0
        };

        let mut left = 0u64;
        let mut right = history_count - 1;

        while (left <= right) {
            let mid = left + (right - left) / 2;
            let history_item = table::borrow(&archive.history, mid);

            if (target_index < history_item.saved_at_length) {
                if (mid == 0) {
                    return mid
                };

                let history_start_index = if (history_item.first_item_is_from_previous_history) {
                    history_item.saved_at_length - vector::length(&history_item.items) + 1
                } else {
                    history_item.saved_at_length - vector::length(&history_item.items)
                };

                if (target_index >= history_start_index) {
                    return mid
                };

                if (mid == 0) {
                    break
                };
                right = mid - 1;
            } else {
                left = mid + 1;
            };

            if (right == 0 && left > right) {
                break
            };
        };

        abort 0
    }

    fun binary_search_history_by_saved_length(endless_v: &EndlessWalrusVector, target_index: u64): u64 {
        if (endless_v.history_items_count == 0) {
            return 0
        };

        let mut left = 0u64;
        let mut right = endless_v.history_items_count - 1;

        while (left <= right) {
            let mid = left + (right - left) / 2;
            let history_item = table::borrow(std::option::borrow(&endless_v.history), mid);

            if (target_index < history_item.saved_at_length) {
                if (mid == 0) {
                    return mid
                };

                let history_start_index = if (history_item.first_item_is_from_previous_history) {
                    history_item.saved_at_length - vector::length(&history_item.items) + 1
                } else {
                    history_item.saved_at_length
                };

                if (target_index >= history_start_index) {
                    return mid
                };

                if (mid == 0) {
                    break
                };
                right = mid - 1;
            } else {
                left = mid + 1;
            };

            if (right == 0 && left > right) {
                break
            };
        };

        endless_v.history_items_count - 1
    }

    fun get_first_not_historied_index(endless_v: &EndlessWalrusVector): u64 {
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            return 0
        } else if (endless_v.first_item_is_from_previous_history) {
            return (endless_v.length - (vector::length(&endless_v.items) - 1))
        };

        return (endless_v.length - (vector::length(&endless_v.items)))
    }

    /// Move all current `.items` into a new history segment, optionally pushing one more item.
    /// - None: just close out the segment.
    /// - Bytes item: split bytes between this segment and the new (empty) `.items`.
    /// - Blob item: store the Blob whole in the new `.items` (no split).
    /// - Empty item (no bytes, no blob): treat as zero-size bytes, push as-is.
    public fun clamp(endless_v: &mut EndlessWalrusVector, push_item: Option<EndlessWalrusItem>) {
        // Drain endless_v.items into a new vector (preserve order). One-pass: reverse-in-place then drain.
        vector::reverse(&mut endless_v.items);
        let mut moved_items = vector::empty<EndlessWalrusItem>();
        while (!vector::is_empty(&endless_v.items)) {
            vector::push_back(&mut moved_items, vector::pop_back(&mut endless_v.items));
        };

        let prior_storage_volume = endless_v.this_object_storage_volume;

        let mut history_item = EndlessWalrusHistory {
            items: moved_items,
            followed_by_next_bytes: 0,
            first_item_is_from_previous_history: endless_v.first_item_is_from_previous_history,
            saved_at_length: endless_v.length,
            storage_volume: prior_storage_volume, // moved-out items had this aggregate
        };

        endless_v.first_item_is_from_previous_history = false;

        if (option::is_some(&push_item)) {
            let new_item = option::destroy_some(push_item);

            if (item::item_is_empty(&new_item)) {
                // Empty item: push as zero-size bytes-equivalent into now-empty items.
                vector::push_back(&mut endless_v.items, new_item);
                endless_v.this_object_storage_volume = 0;
                endless_v.this_object_items_binary_length = 0;
                endless_v.length = endless_v.length + 1;
                history_item.saved_at_length = endless_v.length;
            } else if (item::item_has_blob(&new_item)) {
                // Blob: do not split. Push whole into the (now empty) items.
                let blob_size = item::item_binary_length(&new_item);
                let blob_storage = item::item_storage_volume(&new_item);
                endless_v.binary_length = endless_v.binary_length + blob_size;
                vector::push_back(&mut endless_v.items, new_item);
                endless_v.this_object_storage_volume = blob_storage;
                endless_v.this_object_items_binary_length = blob_size;
                endless_v.length = endless_v.length + 1;
                history_item.saved_at_length = endless_v.length;
            } else {
                // Bytes item: split it.
                let mut bytes = item::destroy_item_into_bytes(new_item);
                endless_v.binary_length = endless_v.binary_length + vector::length(&bytes);

                let free_space_in_history = SAFE_INNER_SIZE - prior_storage_volume;

                if (vector::length(&bytes) <= free_space_in_history) {
                    // Whole thing fits into the closed history segment's head; tail empty.
                    let head_size = vector::length(&bytes);
                    let head_item = item::new_bytes_item(bytes);
                    vector::push_back(&mut history_item.items, head_item);
                    history_item.followed_by_next_bytes = 0;
                    history_item.storage_volume = history_item.storage_volume + head_size;
                    endless_v.this_object_storage_volume = 0;
                    endless_v.this_object_items_binary_length = 0;
                    // endless_v.items already empty after drain at start of clamp
                    endless_v.length = endless_v.length + 1;
                    history_item.saved_at_length = endless_v.length;
                } else {
                    let mut geting_n_of_them = vector::length(&bytes) - free_space_in_history;
                    let mut tail = vector::empty<u8>();
                    while (geting_n_of_them > 0) {
                        let b = vector::pop_back(&mut bytes);
                        vector::push_back(&mut tail, b);
                        geting_n_of_them = geting_n_of_them - 1;
                    };
                    vector::reverse(&mut tail);

                    // bytes now is the head; tail is the trailing fragment
                    let head_size = vector::length(&bytes);
                    let head_item = item::new_bytes_item(bytes);
                    vector::push_back(&mut history_item.items, head_item);
                    history_item.followed_by_next_bytes = vector::length(&tail);
                    history_item.storage_volume = history_item.storage_volume + head_size;

                    let tail_size = vector::length(&tail);
                    endless_v.this_object_storage_volume = tail_size;
                    endless_v.this_object_items_binary_length = tail_size;

                    if (tail_size > 0) {
                        // endless_v.items is already empty (drained at start of clamp)
                        vector::push_back(&mut endless_v.items, item::new_bytes_item(tail));
                        endless_v.first_item_is_from_previous_history = true;
                        endless_v.length = endless_v.length + 1;
                    } else {
                        vector::destroy_empty(tail);
                        // endless_v.items already empty
                        endless_v.length = endless_v.length + 1;
                    };

                    history_item.saved_at_length = endless_v.length;
                };
            };
        } else {
            option::destroy_none(push_item);
            // endless_v.items already drained/empty
            endless_v.this_object_storage_volume = 0;
            endless_v.this_object_items_binary_length = 0;
        };

        table::add(std::option::borrow_mut(&mut endless_v.history), endless_v.history_items_count, history_item);
        endless_v.history_items_count = endless_v.history_items_count + 1;
    }

}
