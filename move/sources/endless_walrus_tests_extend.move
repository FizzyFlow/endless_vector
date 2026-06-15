#[test_only]
module endless_vector::endless_walrus_tests_extend {
    use sui::test_scenario as ts;
    use walrus::{
        blob::{Self, Blob},
        encoding,
        messages,
        system::{Self, System},
        test_utils,
    };
    use endless_vector::endless_walrus::{
        EndlessWalrusVector,
        empty,
        push_back_bytes,
        push_back_blob,
        archive,
        burn,
        borrow_blob_at,
        min_blob_end_epoch,
        extend_blobs_to_epoch,
        extend_blobs_cost_to_epoch,
        history_items_count,
        archive_items_count,
    };

    const TEST_SENDER_ADDR: address = @0x1;

    // Walrus blob registration parameters.
    const RS2: u8 = 1;                  // encoding type RS2
    const SIZE: u64 = 5_000_000;        // unencoded blob size (bytes)
    const N_COINS: u64 = 1_000_000_000; // FROST minted per blob registration
    const SAFE_INNER_SIZE: u64 = 128 * 1024;

    /// Register a fresh, *certified* `Blob` whose storage ends at epoch `epochs_ahead`
    /// (the test system starts at epoch 0). A unique `root_hash` yields a distinct blob_id.
    fun mint_certified_blob(system: &mut System, root_hash: u256, epochs_ahead: u32, ctx: &mut TxContext): Blob {
        let mut wal_coin = test_utils::mint_frost(N_COINS, ctx);
        let storage_size = encoding::encoded_blob_length(SIZE, RS2, system.n_shards());
        let storage = system.reserve_space(storage_size, epochs_ahead, &mut wal_coin, ctx);
        let blob_id = blob::derive_blob_id(root_hash, RS2, SIZE);
        let mut blob = system.register_blob(
            storage,
            blob_id,
            root_hash,
            SIZE,
            RS2,
            false, // permanent (not deletable)
            &mut wal_coin,
            ctx,
        );

        // Certify the blob so it can later be extended (extend requires certified & not expired).
        let certify_message = messages::certified_permanent_blob_message_for_testing(blob.blob_id());
        blob.certify_with_certified_msg_for_testing(system.epoch(), certify_message);

        wal_coin.burn_for_testing();
        blob
    }

    fun push_certified_blob(v: &mut EndlessWalrusVector, system: &mut System, root_hash: u256, epochs_ahead: u32, ctx: &mut TxContext) {
        let blob = mint_certified_blob(system, root_hash, epochs_ahead, ctx);
        push_back_blob(v, blob);
    }

    /// Generate `n` deterministic, non-zero bytes (so the item triggers a clamp when large).
    fun bytes_of_len(n: u64): vector<u8> {
        let mut out = vector::empty<u8>();
        let mut i = 0;
        while (i < n) {
            vector::push_back(&mut out, ((i % 251) + 1) as u8);
            i = i + 1;
        };
        out
    }

    // ======================================================================
    // min_blob_end_epoch
    // ======================================================================

    #[test]
    fun test_min_blob_end_epoch_picks_smallest() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        // Blobs ending at epochs 4, 2, 6; a bytes item (no epoch) interleaved.
        push_certified_blob(&mut v, &mut system, 0xA1, 4, ctx);
        push_back_bytes(&mut v, b"no-epoch");
        push_certified_blob(&mut v, &mut system, 0xA2, 2, ctx);
        push_certified_blob(&mut v, &mut system, 0xA3, 6, ctx);

        assert!(min_blob_end_epoch(&v) == std::option::some(2u32), 0);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_min_blob_end_epoch_none_without_blobs() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut v = empty(ctx);
        push_back_bytes(&mut v, b"only");
        push_back_bytes(&mut v, b"bytes");

        assert!(min_blob_end_epoch(&v) == std::option::none<u32>(), 0);

        burn(v);
        ts::end(scenario);
    }

    // ======================================================================
    // extend_blobs_to_epoch
    // ======================================================================

    #[test]
    fun test_extend_all_items_to_target() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_certified_blob(&mut v, &mut system, 0xB1, 2, ctx);
        push_certified_blob(&mut v, &mut system, 0xB2, 3, ctx);
        push_certified_blob(&mut v, &mut system, 0xB3, 4, ctx);

        assert!(min_blob_end_epoch(&v) == std::option::some(2u32), 0);

        let mut payment = test_utils::mint_frost(N_COINS, ctx);
        extend_blobs_to_epoch(&mut v, &mut system, 6, &mut payment);
        payment.burn_for_testing();

        // Every blob now ends at the target epoch 6.
        assert!(blob::end_epoch(borrow_blob_at(&v, 0)) == 6, 1);
        assert!(blob::end_epoch(borrow_blob_at(&v, 1)) == 6, 2);
        assert!(blob::end_epoch(borrow_blob_at(&v, 2)) == 6, 3);
        assert!(min_blob_end_epoch(&v) == std::option::some(6u32), 4);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_extend_skips_blobs_already_beyond_target() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_certified_blob(&mut v, &mut system, 0xC1, 3, ctx); // below target -> extended
        push_certified_blob(&mut v, &mut system, 0xC2, 8, ctx); // beyond target -> untouched

        let mut payment = test_utils::mint_frost(N_COINS, ctx);
        extend_blobs_to_epoch(&mut v, &mut system, 5, &mut payment);
        payment.burn_for_testing();

        assert!(blob::end_epoch(borrow_blob_at(&v, 0)) == 5, 0);
        assert!(blob::end_epoch(borrow_blob_at(&v, 1)) == 8, 1);
        assert!(min_blob_end_epoch(&v) == std::option::some(5u32), 2);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_extend_no_op_when_all_sufficient() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        push_certified_blob(&mut v, &mut system, 0xD1, 5, ctx);
        push_certified_blob(&mut v, &mut system, 0xD2, 6, ctx);

        // Target below both end epochs: nothing to do (must not abort on an empty payment).
        let mut payment = test_utils::mint_frost(0, ctx);
        extend_blobs_to_epoch(&mut v, &mut system, 4, &mut payment);
        payment.burn_for_testing();

        assert!(blob::end_epoch(borrow_blob_at(&v, 0)) == 5, 0);
        assert!(blob::end_epoch(borrow_blob_at(&v, 1)) == 6, 1);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_extend_covers_items_history_and_archive() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        // Blob A -> archive tier.
        push_certified_blob(&mut v, &mut system, 0xE1, 3, ctx);
        archive(&mut v, ctx);
        assert!(archive_items_count(&v) == 1, 0);

        // Blob B -> history tier: push it, then push a large bytes item to force a clamp,
        // which moves B (and the bytes head) into a new history segment.
        push_certified_blob(&mut v, &mut system, 0xE2, 3, ctx);
        push_back_bytes(&mut v, bytes_of_len(SAFE_INNER_SIZE - 10));
        assert!(history_items_count(&v) > 0, 1);

        // Blob C -> current items tier.
        push_certified_blob(&mut v, &mut system, 0xE3, 3, ctx);

        // All three blobs end at epoch 3 across the three tiers.
        assert!(min_blob_end_epoch(&v) == std::option::some(3u32), 2);

        let mut payment = test_utils::mint_frost(N_COINS, ctx);
        extend_blobs_to_epoch(&mut v, &mut system, 7, &mut payment);
        payment.burn_for_testing();

        // The minimum across items + history + archive lifted to the target -> every tier
        // was visited and extended.
        assert!(min_blob_end_epoch(&v) == std::option::some(7u32), 3);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }

    #[test]
    fun test_extend_cost_matches_actual_spend() {
        // `extend_blobs_cost_to_epoch` must predict the exact WAL the extend deducts:
        // fund a coin with precisely that amount and assert it is fully drained.
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut system = system::new_for_testing(ctx);
        let mut v = empty(ctx);

        // Blobs across all three tiers, ending at epoch 3.
        push_certified_blob(&mut v, &mut system, 0xF1, 3, ctx);
        archive(&mut v, ctx);                                   // -> archive tier
        push_certified_blob(&mut v, &mut system, 0xF2, 3, ctx);
        push_back_bytes(&mut v, bytes_of_len(SAFE_INNER_SIZE - 10)); // clamp -> history tier
        push_certified_blob(&mut v, &mut system, 0xF3, 3, ctx);  // -> current items tier

        let target = 7u32;
        let price_per_unit = system.storage_price_per_unit_size();
        let cost = extend_blobs_cost_to_epoch(&v, &system, target, price_per_unit);
        assert!(cost > 0, 0);

        // Fund a coin with exactly the predicted cost; after extend it must be empty.
        let mut payment = test_utils::mint_frost(cost, ctx);
        extend_blobs_to_epoch(&mut v, &mut system, target, &mut payment);
        assert!(payment.value() == 0, 1);
        payment.burn_for_testing();

        assert!(min_blob_end_epoch(&v) == std::option::some(target), 2);

        // Idempotent: once every blob reaches the target, the cost is zero.
        assert!(extend_blobs_cost_to_epoch(&v, &system, target, price_per_unit) == 0, 3);

        burn(v);
        system.destroy_for_testing();
        ts::end(scenario);
    }
}
