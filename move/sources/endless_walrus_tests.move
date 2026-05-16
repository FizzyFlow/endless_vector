#[test_only]
module endless_vector::endless_walrus_tests {
    use sui::test_scenario as ts;
    use endless_vector::endless_walrus::{
        EndlessWalrusVector,
        empty,
        empty_and_push,
        push_back_bytes,
        read_bytes_at,
        update_bytes_at,
        archive,
        burn_archive,
        burn,
        concat,
        append,
        has_items_from,
        length,
        size,
        history_items_count,
        archive_items_count,
    };

    const TEST_SENDER_ADDR: address = @0x1;
    const SAFE_INNER_SIZE: u64 = 128*1024;

    // Mirror of error codes in endless_walrus (kept in sync; abort_code requires literal/local const).
    const EArchiveHasBeenBurned: u64 = 92;
    const ECannotUpdateArchivedItem: u64 = 93;
    const ESizeExceedsLimit: u64 = 94;
    const EIndexOutOfBounds: u64 = 96;
    const ECannotConcatWithArchivedItems: u64 = 97;

    #[test]
    fun test_add_a_lot() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let created_endless_v = empty(ts::ctx(&mut scenario));
        transfer::public_share_object(created_endless_v);

        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v: EndlessWalrusVector = ts::take_shared(&scenario);

        let mut test_compare = vector::empty<vector<u8>>();

        let pseudo_random_seed = 312333;
        let max_i = 120;
        let max_chunk_length = 90240;

        // Generate the base buffer ONCE; per-iteration data is derived cheaply from it.
        let base = pseudo_random_bytes(pseudo_random_seed, max_chunk_length);

        let mut i = 0;
        let mut expected_binary_length = 0;
        while (i < max_i) {
            let mut chunk_length = 1000;
            if (i > 200 && i % 3 == 0) {
                chunk_length = 27;
            };
            if (i > 200 && i % 10 == 0) {
                chunk_length = 10240;
            };
            if (i > 200 && i % 120 == 0) {
                chunk_length = 90240;
            };

            let data = derive_test_bytes(&base, chunk_length, i);
            expected_binary_length = expected_binary_length + chunk_length;
            test_compare.push_back(data);
            push_back_bytes(&mut endless_v, data);

            i = i + 1;

            assert!(length(&endless_v) == i, 0);
            assert!(size(&endless_v) == expected_binary_length, 0);

            if (i % 30 == 0) {
                archive(&mut endless_v, ts::ctx(&mut scenario));
            };
        };

        i = 0;
        while (i < max_i) {
            let data_simple = vector::borrow(&test_compare, i);
            let data_endless_v = read_bytes_at(&endless_v, i);

            assert!(vector::length(data_simple) == vector::length(&data_endless_v), 0);
            assert!(vectors_equal(data_simple, &data_endless_v), 0);

            i = i + 1;
        };

        assert!(length(&endless_v) == max_i, 0);

        burn_archive(&mut endless_v);

        assert!(length(&endless_v) == max_i, 0);

        let should_be_items_from_index = has_items_from(&endless_v);

        assert!(should_be_items_from_index > 0, 0);

        i = should_be_items_from_index;
        while (i < max_i) {
            let data_simple = vector::borrow(&test_compare, i);
            let data_endless_v = read_bytes_at(&endless_v, i);
            assert!(vector::length(data_simple) == vector::length(&data_endless_v), 0);
            assert!(vectors_equal(data_simple, &data_endless_v), 0);

            i = i + 1;
        };

        ts::return_shared(endless_v);

        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = EArchiveHasBeenBurned, location = endless_vector::endless_walrus), allow(unused_variable)]
    fun burned_archive_is_not_available() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let created_endless_v = empty(ts::ctx(&mut scenario));
        transfer::public_transfer(created_endless_v, TEST_SENDER_ADDR);

        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v: EndlessWalrusVector = ts::take_from_sender(&scenario);

        let pseudo_random_seed = 312333;
        let chunk_length = 1000;
        push_back_bytes(&mut endless_v, pseudo_random_bytes(pseudo_random_seed, chunk_length));

        archive(&mut endless_v, ts::ctx(&mut scenario));

        burn_archive(&mut endless_v);

        let should_fail = read_bytes_at(&endless_v, 0);

        ts::return_to_sender(&scenario, endless_v);
        ts::end(scenario);
    }

    #[test]
    fun test_update_at() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        push_back_bytes(&mut endless_v, b"Hello");
        push_back_bytes(&mut endless_v, b"World");
        push_back_bytes(&mut endless_v, b"Test");

        assert!(length(&endless_v) == 3, 0);
        let initial_size = size(&endless_v);

        update_bytes_at(&mut endless_v, 0, b"Howdy");
        assert!(read_bytes_at(&endless_v, 0) == b"Howdy", 0);
        assert!(size(&endless_v) == initial_size, 0);

        update_bytes_at(&mut endless_v, 1, b"Universe");
        assert!(read_bytes_at(&endless_v, 1) == b"Universe", 0);
        assert!(size(&endless_v) == initial_size + 3, 0);

        update_bytes_at(&mut endless_v, 2, b"OK");
        assert!(read_bytes_at(&endless_v, 2) == b"OK", 0);
        assert!(size(&endless_v) == initial_size + 3 - 2, 0);

        let mut i = 0;
        while (i < 200) {
            push_back_bytes(&mut endless_v, pseudo_random_bytes(i, 1000));
            i = i + 1;
        };

        assert!(history_items_count(&endless_v) > 0, 0);

        let current_index = length(&endless_v) - 1;
        update_bytes_at(&mut endless_v, current_index, b"Updated Current");
        assert!(read_bytes_at(&endless_v, current_index) == b"Updated Current", 0);

        update_bytes_at(&mut endless_v, 5, b"Updated History");
        assert!(read_bytes_at(&endless_v, 5) == b"Updated History", 0);

        archive(&mut endless_v, ts::ctx(&mut scenario));

        push_back_bytes(&mut endless_v, b"After Archive");

        let recent_index = length(&endless_v) - 1;
        update_bytes_at(&mut endless_v, recent_index, b"Updated Recent");
        assert!(read_bytes_at(&endless_v, recent_index) == b"Updated Recent", 0);

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECannotUpdateArchivedItem, location = endless_vector::endless_walrus)]
    fun test_update_archived_item_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        let mut i = 0;
        while (i < 300) {
            push_back_bytes(&mut endless_v, pseudo_random_bytes(i, 1000));
            i = i + 1;
        };

        archive(&mut endless_v, ts::ctx(&mut scenario));

        update_bytes_at(&mut endless_v, 0, b"Should Fail");

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EIndexOutOfBounds, location = endless_vector::endless_walrus)]
    fun test_update_out_of_bounds_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        push_back_bytes(&mut endless_v, b"Test");

        update_bytes_at(&mut endless_v, 10, b"Should Fail");

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ESizeExceedsLimit, location = endless_vector::endless_walrus)]
    fun test_update_exceeds_size_limit_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        push_back_bytes(&mut endless_v, pseudo_random_bytes(0, SAFE_INNER_SIZE - 2000));
        push_back_bytes(&mut endless_v, pseudo_random_bytes(1, 1000));

        update_bytes_at(&mut endless_v, 1, pseudo_random_bytes(2, 2001));

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_update_split_item() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        push_back_bytes(&mut endless_v, pseudo_random_bytes(0, SAFE_INNER_SIZE - 10000));

        let large_item = pseudo_random_bytes(1, 15000);
        push_back_bytes(&mut endless_v, large_item);

        assert!(history_items_count(&endless_v) > 0, 0);

        let original_item_bytes = read_bytes_at(&endless_v, 1);
        assert!(vector::length(&original_item_bytes) == 15000, 0);

        let new_item = pseudo_random_bytes(100, 12000);
        update_bytes_at(&mut endless_v, 1, new_item);

        let updated_item = read_bytes_at(&endless_v, 1);
        assert!(vector::length(&updated_item) == 12000, 0);
        assert!(vectors_equal(&updated_item, &pseudo_random_bytes(100, 12000)), 0);

        let item0 = read_bytes_at(&endless_v, 0);
        assert!(vector::length(&item0) == SAFE_INNER_SIZE - 10000, 0);

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_update_10000_items() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        let original_string = b"Hey there Sui Fam!";
        let updated_string = b"Hey, hey, Sui Fam!";

        let mut i = 0;
        while (i < 7000) {
            push_back_bytes(&mut endless_v, original_string);
            i = i + 1;
        };

        assert!(length(&endless_v) == 7000, 0);

        i = 0;
        while (i < 7000) {
            update_bytes_at(&mut endless_v, i, updated_string);
            i = i + 1;
        };

        i = 0;
        while (i < 7000) {
            let bytes = read_bytes_at(&endless_v, i);
            assert!(vectors_equal(&bytes, &updated_string), 0);
            i = i + 1;
        };

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_concat() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        // Pre-generate base bytes once; per-iteration data is derived cheaply.
        let chunk_length = 1000;
        let n1 = 80;
        let n2 = 70;
        let base = pseudo_random_bytes(7, chunk_length);

        let mut endless_v1 = empty(ctx);

        let mut i = 0;
        while (i < n1) {
            let data = derive_test_bytes(&base, chunk_length, i);
            push_back_bytes(&mut endless_v1, data);
            i = i + 1;
        };

        let v1_length = length(&endless_v1);
        let v1_binary_length = size(&endless_v1);

        let mut endless_v2 = empty(ctx);

        i = 0;
        while (i < n2) {
            let data = derive_test_bytes(&base, chunk_length, i + 100);
            push_back_bytes(&mut endless_v2, data);
            i = i + 1;
        };

        let v2_length = length(&endless_v2);
        let v2_binary_length = size(&endless_v2);

        concat(&mut endless_v1, endless_v2);

        assert!(length(&endless_v1) == v1_length + v2_length, 0);
        assert!(size(&endless_v1) == v1_binary_length + v2_binary_length, 1);

        i = 0;
        while (i < n1) {
            let expected_data = derive_test_bytes(&base, chunk_length, i);
            let actual_data = read_bytes_at(&endless_v1, i);
            assert!(vectors_equal(&actual_data, &expected_data), 2);
            i = i + 1;
        };

        i = 0;
        while (i < n2) {
            let expected_data = derive_test_bytes(&base, chunk_length, i + 100);
            let actual_data = read_bytes_at(&endless_v1, i + n1);
            assert!(vectors_equal(&actual_data, &expected_data), 3);
            i = i + 1;
        };

        transfer::public_transfer(endless_v1, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECannotConcatWithArchivedItems, location = endless_vector::endless_walrus)]
    fun test_concat_with_archived_items_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut endless_v1 = empty(ctx);
        push_back_bytes(&mut endless_v1, b"Vector 1");

        let mut endless_v2 = empty(ctx);

        let mut i = 0;
        while (i < 100) {
            let data = pseudo_random_bytes(i, 2000);
            push_back_bytes(&mut endless_v2, data);
            i = i + 1;
        };

        archive(&mut endless_v2, ctx);

        push_back_bytes(&mut endless_v2, b"After archive");

        concat(&mut endless_v1, endless_v2);

        transfer::public_transfer(endless_v1, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_append_multiple_vectors() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut endless_v1 = empty(ctx);
        push_back_bytes(&mut endless_v1, b"Vector 1 - Item 1");
        push_back_bytes(&mut endless_v1, b"Vector 1 - Item 2");

        let v1_length = length(&endless_v1);
        let v1_binary_length = size(&endless_v1);

        let mut endless_v2 = empty(ctx);
        push_back_bytes(&mut endless_v2, b"Vector 2 - Item 1");
        push_back_bytes(&mut endless_v2, b"Vector 2 - Item 2");

        let v2_length = length(&endless_v2);
        let v2_binary_length = size(&endless_v2);

        let mut endless_v3 = empty(ctx);
        push_back_bytes(&mut endless_v3, b"Vector 3 - Item 1");
        push_back_bytes(&mut endless_v3, b"Vector 3 - Item 2");
        push_back_bytes(&mut endless_v3, b"Vector 3 - Item 3");

        let v3_length = length(&endless_v3);
        let v3_binary_length = size(&endless_v3);

        let mut others = vector::empty<EndlessWalrusVector>();
        vector::push_back(&mut others, endless_v2);
        vector::push_back(&mut others, endless_v3);

        append(&mut endless_v1, others);

        assert!(length(&endless_v1) == v1_length + v2_length + v3_length, 0);
        assert!(size(&endless_v1) == v1_binary_length + v2_binary_length + v3_binary_length, 1);

        assert!(read_bytes_at(&endless_v1, 0) == b"Vector 1 - Item 1", 2);
        assert!(read_bytes_at(&endless_v1, 1) == b"Vector 1 - Item 2", 3);
        assert!(read_bytes_at(&endless_v1, 2) == b"Vector 2 - Item 1", 4);
        assert!(read_bytes_at(&endless_v1, 3) == b"Vector 2 - Item 2", 5);
        assert!(read_bytes_at(&endless_v1, 4) == b"Vector 3 - Item 1", 6);
        assert!(read_bytes_at(&endless_v1, 5) == b"Vector 3 - Item 2", 7);
        assert!(read_bytes_at(&endless_v1, 6) == b"Vector 3 - Item 3", 8);

        transfer::public_transfer(endless_v1, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_empty_and_push() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut items = vector::empty<vector<u8>>();
        vector::push_back(&mut items, b"Item 1");
        vector::push_back(&mut items, b"Item 2");
        vector::push_back(&mut items, b"Item 3");

        let endless_v = empty_and_push(items, ctx);

        assert!(length(&endless_v) == 3, 0);
        assert!(size(&endless_v) == 18, 1);

        assert!(read_bytes_at(&endless_v, 0) == b"Item 1", 2);
        assert!(read_bytes_at(&endless_v, 1) == b"Item 2", 3);
        assert!(read_bytes_at(&endless_v, 2) == b"Item 3", 4);

        transfer::public_transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_burn_empty_vector() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let empty_v = empty(ctx);
        assert!(length(&empty_v) == 0, 0);
        assert!(size(&empty_v) == 0, 1);
        burn(empty_v);

        ts::end(scenario);
    }

    #[test]
    fun test_burn_vector_with_items() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut v_with_items = empty(ctx);
        push_back_bytes(&mut v_with_items, b"Item 1");
        push_back_bytes(&mut v_with_items, b"Item 2");
        push_back_bytes(&mut v_with_items, b"Item 3");
        assert!(length(&v_with_items) == 3, 0);
        burn(v_with_items);

        ts::end(scenario);
    }

    #[test]
    fun test_burn_vector_with_history() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut v_with_history = empty(ctx);
        let mut i = 0;
        while (i < 100) {
            push_back_bytes(&mut v_with_history, pseudo_random_bytes(i, 2000));
            i = i + 1;
        };
        assert!(history_items_count(&v_with_history) > 0, 0);
        assert!(length(&v_with_history) == 100, 1);
        burn(v_with_history);

        ts::end(scenario);
    }

    #[test]
    fun test_burn_vector_with_archive() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        let mut v_with_archive = empty(ctx);
        let mut i = 0;
        while (i < 100) {
            push_back_bytes(&mut v_with_archive, pseudo_random_bytes(i + 1000, 2000));
            i = i + 1;
        };
        archive(&mut v_with_archive, ctx);
        assert!(archive_items_count(&v_with_archive) > 0, 0);
        push_back_bytes(&mut v_with_archive, b"After archive");
        assert!(length(&v_with_archive) == 101, 1);
        burn(v_with_archive);

        ts::end(scenario);
    }

    // ===== test helpers =====

    fun pseudo_random_bytes(seed: u64, count: u64): vector<u8> {
        let mut result = vector::empty<u8>();
        let mut nonce = 0u64;

        while (vector::length(&result) < count) {
            let chunk = std::hash::sha3_256(u64_to_bytes(seed ^ nonce));
            let needed = count - vector::length(&result);
            let mut take = 32;
            if (needed < 32) {
                take = needed;
            };

            let mut i = 0;
            while (i < take) {
                let byte = *vector::borrow(&chunk, i);
                vector::push_back(&mut result, byte);
                i = i + 1;
            };

            nonce = nonce + 1;
        };

        result
    }

    /// Cheaply derive `count` test bytes from a pre-generated `base` buffer, perturbed by `seed`.
    /// Avoids the per-call sha3 hashing of `pseudo_random_bytes`.
    fun derive_test_bytes(base: &vector<u8>, count: u64, seed: u64): vector<u8> {
        let mut data = vector::empty<u8>();
        let mut k = 0;
        while (k < count) {
            vector::push_back(&mut data, *vector::borrow(base, k));
            k = k + 1;
        };
        if (count == 0) return data;
        let mut p = 0;
        while (p < 4) {
            let pos = (seed + p * 7919) % count;
            let shift = ((p * 8) as u8);
            let mix = (((seed >> shift) & 0xFF) as u8) ^ ((p as u8) + 1);
            let old = *vector::borrow(&data, pos);
            *vector::borrow_mut(&mut data, pos) = old ^ mix;
            p = p + 1;
        };
        data
    }

    fun vectors_equal<T>(v1: &vector<T>, v2: &vector<T>): bool {
        let len1 = vector::length(v1);
        let len2 = vector::length(v2);

        if (len1 != len2) {
            return false
        };

        let mut i = 0;
        while (i < len1) {
            if (vector::borrow(v1, i) != vector::borrow(v2, i)) {
                return false
            };
            i = i + 1;
        };

        true
    }

    fun u64_to_bytes(x: u64): vector<u8> {
        let mut out = vector::empty<u8>();
        let mut shift = 0;
        while (shift < 64) {
            vector::push_back(&mut out, ((x >> shift) & 0xFF) as u8);
            shift = shift + 8;
        };

        out
    }
}
