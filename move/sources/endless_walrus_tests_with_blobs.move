#[test_only]
module endless_vector::endless_walrus_tests_with_blobs {
    use sui::test_scenario as ts;
    use walrus::{
        blob::{Self, Blob},
        encoding,
        system::{Self, System},
        test_utils,
    };
    use endless_vector::endless_walrus::{
        EndlessWalrusVector,
        empty,
        push_back,
        push_back_bytes,
        push_back_blob,
        get_at,
        read_bytes_at,
        borrow_blob_at,
        update_at,
        archive,
        burn,
        length,
        size,
        history_items_count,
    };
    use endless_vector::endless_walrus_item::{
        Self as item,
        EndlessWalrusItem,
        new_bytes_item,
        new_blob_item,
        new_empty_item,
        item_has_bytes,
        item_has_blob,
        item_is_empty,
        item_storage_volume,
    };

    const TEST_SENDER_ADDR: address = @0x1;

    // Mirror error codes (for #[expected_failure] location-typed checks).
    const ENotABytesItem: u64 = 100;
    const ENotABlobItem: u64 = 101;

    // Walrus blob registration parameters.
    const RS2: u8 = 1;                  // encoding type RS2
    const SIZE: u64 = 5_000_000;        // unencoded blob size (bytes)
    const EPOCHS_AHEAD: u32 = 3;
    const N_COINS: u64 = 1_000_000_000;

    /// Register a fresh `Blob` with a unique `root_hash` (so each call gets a different blob_id).
    fun mint_test_blob_and_push_to_v(system: &mut System, root_hash: u256, ctx: &mut TxContext): Blob {
        let mut wal_coin = test_utils::mint_frost(N_COINS, ctx);
        let storage_size = encoding::encoded_blob_length(SIZE, RS2, system.n_shards());
        let storage = system.reserve_space(storage_size, EPOCHS_AHEAD, &mut wal_coin, ctx);
        let blob_id = blob::derive_blob_id(root_hash, RS2, SIZE);
        let blob = system.register_blob(
            storage,
            blob_id,
            root_hash,
            SIZE,
            RS2,
            false, // not deletable
            &mut wal_coin,
            ctx,
        );
        wal_coin.burn_for_testing();
        blob
    }

    /// Push a freshly-minted Blob and return the blob_id for later verification.
    fun push_blob(endless_v: &mut EndlessWalrusVector, system: &mut System, root_hash: u256, ctx: &mut TxContext): u256 {
        let blob = mint_test_blob_and_push_to_v(system, root_hash, ctx);
        let id = blob.blob_id();
        push_back_blob(endless_v, blob);
        id
    }

    #[test]
    fun test_push_back_blob_basic() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        let id0 = push_blob(&mut v, &mut system, 0xAAA, ctx);
        let id1 = push_blob(&mut v, &mut system, 0xBBB, ctx);
        let id2 = push_blob(&mut v, &mut system, 0xCCC, ctx);

        assert!(length(&v) == 3, 0);
        // binary_length sums item_binary_length; for blobs that's blob.size() == SIZE.
        assert!(size(&v) == 3 * SIZE, 1);
        // No history yet — blobs contribute only BLOB_STORAGE_VOLUME each, far below SAFE_INNER_SIZE.
        assert!(history_items_count(&v) == 0, 2);

        // Each item is a blob, with the expected blob_id.
        let it0 = get_at(&v, 0);
        assert!(item_has_blob(it0), 3);
        assert!(!item_has_bytes(it0), 4);
        assert!(item::item_borrow_blob(it0).blob_id() == id0, 5);

        assert!(borrow_blob_at(&v, 1).blob_id() == id1, 6);
        assert!(borrow_blob_at(&v, 2).blob_id() == id2, 7);

        // burn drops the vector, calling walrus::blob::burn on each blob (frees Storage).
        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_blob_storage_volume_is_small() {
        // Each blob contributes only `BLOB_STORAGE_VOLUME` (32 bytes) to the on-object
        // storage_volume, so many blobs fit into a single segment without triggering clamp.
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        let mut i = 0u64;
        while (i < 10) {
            push_blob(&mut v, &mut system, (0x1000 + i) as u256, ctx);
            i = i + 1;
        };

        assert!(length(&v) == 10, 0);
        // 10 × 32 bytes is far below SAFE_INNER_SIZE, so no history segment yet.
        assert!(history_items_count(&v) == 0, 1);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_mixed_blobs_and_bytes() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_back_bytes(&mut v, b"first");
        let blob_id = push_blob(&mut v, &mut system, 0xDEAD, ctx);
        push_back_bytes(&mut v, b"third");
        let blob_id2 = push_blob(&mut v, &mut system, 0xBEEF, ctx);
        push_back_bytes(&mut v, b"fifth");

        assert!(length(&v) == 5, 0);

        // Bytes via read_bytes_at.
        assert!(read_bytes_at(&v, 0) == b"first", 1);
        assert!(read_bytes_at(&v, 2) == b"third", 2);
        assert!(read_bytes_at(&v, 4) == b"fifth", 3);

        // Blobs via borrow_blob_at and item predicates.
        assert!(borrow_blob_at(&v, 1).blob_id() == blob_id, 4);
        assert!(borrow_blob_at(&v, 3).blob_id() == blob_id2, 5);
        assert!(item_has_blob(get_at(&v, 1)), 6);
        assert!(item_has_bytes(get_at(&v, 0)), 7);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotABytesItem, location = endless_vector::endless_walrus)]
    fun test_read_bytes_at_aborts_on_blob() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_blob(&mut v, &mut system, 0x1234, ctx);

        // Should abort with ENotABytesItem.
        let _ = read_bytes_at(&v, 0);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotABlobItem, location = endless_vector::endless_walrus)]
    fun test_borrow_blob_at_aborts_on_bytes() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut v = empty(ctx);
        push_back_bytes(&mut v, b"only bytes");

        // Should abort with ENotABlobItem.
        let _ = borrow_blob_at(&v, 0);

        burn(v);
        ts::end(scenario);
    }

    #[test]
    fun test_update_replace_bytes_with_blob() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_back_bytes(&mut v, b"hello");
        push_back_bytes(&mut v, b"world");

        assert!(item_has_bytes(get_at(&v, 0)), 0);

        let blob = mint_test_blob_and_push_to_v(&mut system, 0x4242, ctx);
        let blob_id = blob.blob_id();
        update_at(&mut v, 0, new_blob_item(blob));

        // Index 0 is now a blob; index 1 is unchanged bytes.
        assert!(item_has_blob(get_at(&v, 0)), 1);
        assert!(borrow_blob_at(&v, 0).blob_id() == blob_id, 2);
        assert!(read_bytes_at(&v, 1) == b"world", 3);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_update_replace_blob_with_bytes() {
        // Replacing a blob with bytes consumes (burns) the old blob's storage via burn_item.
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_blob(&mut v, &mut system, 0xAABB, ctx);
        assert!(item_has_blob(get_at(&v, 0)), 0);

        update_at(&mut v, 0, new_bytes_item(b"replacement"));
        assert!(item_has_bytes(get_at(&v, 0)), 1);
        assert!(read_bytes_at(&v, 0) == b"replacement", 2);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_archive_with_blobs_and_burn_archive() {
        // Push blobs, archive, push more, then burn. Archive should hold the blobs;
        // burn() frees them.
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_blob(&mut v, &mut system, 0x101, ctx);
        push_blob(&mut v, &mut system, 0x102, ctx);
        push_back_bytes(&mut v, b"between");
        push_blob(&mut v, &mut system, 0x103, ctx);

        archive(&mut v, ctx);

        // After archive, items in current segment are 0 (everything moved to archive).
        push_blob(&mut v, &mut system, 0x104, ctx);
        push_back_bytes(&mut v, b"after-archive");

        assert!(length(&v) == 6, 0);

        // Burning the vector frees both archived and current blobs (storage destroyed).
        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_empty_item_in_vector() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut v = empty(ctx);
        push_back(&mut v, new_empty_item());
        push_back_bytes(&mut v, b"after empty");

        assert!(length(&v) == 2, 0);
        assert!(item_is_empty(get_at(&v, 0)), 1);
        assert!(item_storage_volume(get_at(&v, 0)) == 0, 2);
        assert!(read_bytes_at(&v, 1) == b"after empty", 3);

        burn(v);
        ts::end(scenario);
    }
}
