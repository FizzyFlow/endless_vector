module endless_vector::endless_vector {
    const VERSION: u64 = 1;

    const SAFE_INNER_SIZE: u64 = 128*1024;  // max_move_object_size: Some(250 * 1024),
                                            // but we need to respect max_tx_size_bytes: Some(128 * 1024), too

    #[test_only]
    use sui::test_scenario as ts;

    use sui::table::{Self, Table};

    #[test_only]
    use std::debug;

    const EChunkIsTooLarge: u64 = 91;
    const EArchiveHasBeenBurned: u64 = 92;
    const ECannotUpdateArchivedItem: u64 = 93;
    const ESizeExceedsLimit: u64 = 94;
    const ECannotUpdateSplitItem: u64 = 95;
    const EIndexOutOfBounds: u64 = 96;
    const ECannotConcatWithArchivedItems: u64 = 97;

    public struct EndlessVector has key {
        id: UID,
        items: vector<vector<u8>>,
        first_item_is_from_previous_history: bool, // if the first item should be appended to the last one from the previous EndlessVectorHistory

        length: u64,    // total number of items, including those in history and archive, this value can not decrease
        binary_length: u64, // total binary length of all items, including those in history and archive, this value can not decrease
        this_object_items_binary_length: u64, // total binary length of .items stored directly in this object ( without Tables )

        history: Option<Table<u64, EndlessVectorHistory>>, // history of items that were in .items but got clamped ( to fit into object size limits )
        history_items_count: u64,

        archive: Table<u64, EndlessVectorArchive>, // archive of history items that were in .history but got archived ( to speed up access to recent items )
        archive_items_count: u64,
        archived_at_length: u64,    // EndlessVector.length value at which the last archive was created

        archived_from_length: u64,   // in case start of the archive has been burned,
        burned_archive_count: u64,    // how many archive items have been burned from the start of the archive

        made_with_version: u64, // version of the module when this EndlessVector was created
        meta: vector<u8>, // just in case we need to store some extra info in the future
    }

    public struct EndlessVectorHistory has store, drop {
        items: vector<vector<u8>>,
        followed_by_next_bytes: u64,               // last item is truncated and followed by the N byes from the first item of the next EndlessVectorHistory
        first_item_is_from_previous_history: bool, // if the first item should be appended to the last one from the previous EndlessVectorHistory
        saved_at_length: u64,
    }

    public struct EndlessVectorArchive has store, key {
        id: UID,
        history: Table<u64, EndlessVectorHistory>,
        archived_at_length: u64,    // EndlessVector.length value at which this archive was created
        length: u64,      // total number of items in this archive
    }

    public fun empty_entry(ctx: &mut TxContext) {
        let endless_vector = empty(ctx);
        transfer::transfer(endless_vector, ctx.sender());
    }

    public fun empty(ctx: &mut TxContext): EndlessVector {
        EndlessVector {
            id: object::new(ctx),

            items: vector::empty(),
            first_item_is_from_previous_history: false,
            length: 0,
            binary_length: 0,
            this_object_items_binary_length: 0,

            history: std::option::some(table::new(ctx)),
            history_items_count: 0,

            archive: table::new(ctx),
            archive_items_count: 0,
            archived_at_length: 0,

            archived_from_length: 0,
            burned_archive_count: 0,

            made_with_version: VERSION,
            meta: vector::empty<u8>(),
        }
    }

    /**
        Creates a new EndlessVector and pushes multiple items to it.
        Returns the EndlessVector with all items pushed.
    */
    public fun empty_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext): EndlessVector {
        let mut endless_v = empty(ctx);
        let mut i = 0;
        let len = vector::length(&items_to_push);

        while (i < len) {
            let item = vector::borrow(&items_to_push, i);
            push_back(&mut endless_v, *item);
            i = i + 1;
        };

        endless_v
    }

    /**
        Creates a new EndlessVector, pushes multiple items to it, and transfers it to the sender.
        Entry function wrapper around empty_and_push.
    */
    public fun empty_entry_and_push(items_to_push: vector<vector<u8>>, ctx: &mut TxContext) {
        let endless_v = empty_and_push(items_to_push, ctx);
        transfer::transfer(endless_v, ctx.sender());
    }

    /**
        Concatenates all items from the second EndlessVector to the first one by transferring
        history, and current items directly without copying item by item.
        The second vector will be consumed (destroyed) in the process.
    */
    public fun concat(endless_v: &mut EndlessVector, other: EndlessVector) {
        let EndlessVector {
            id: other_id,
            items: other_items,
            first_item_is_from_previous_history: other_first_item_is_from_previous_history,
            length: other_length,
            binary_length: other_binary_length,
            this_object_items_binary_length: _,
            history: other_history,
            history_items_count: other_history_items_count,
            archive: other_archive,
            archive_items_count: other_archive_items_count,
            archived_at_length: _,
            archived_from_length: _,
            burned_archive_count: _,
            made_with_version: _,
            meta: _,
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
                let mut history_item: EndlessVectorHistory = table::remove(&mut other_history_table, history_idx);
                // Adjust the saved_at_length to account for the offset (use original_length)
                history_item.saved_at_length = history_item.saved_at_length + original_length;

                if (std::option::is_none(&endless_v.history)) {
                    abort 99 // should never happen, but just in case
                };

                table::add(std::option::borrow_mut(&mut endless_v.history), endless_v.history_items_count, history_item);
                endless_v.history_items_count = endless_v.history_items_count + 1;
                history_idx = history_idx + 1;
            };
            table::drop(other_history_table);
        } else {
            std::option::destroy_none(other_history);
        };

        // Transfer current items from other - don't use push_back to avoid double-counting
        // Instead, directly append items and manually update tracking fields
        let other_items_len = vector::length(&other_items);
        let mut item_idx = 0;
        let mut other_items_binary_length = 0u64;
        while (item_idx < other_items_len) {
            let item = vector::borrow(&other_items, item_idx);
            other_items_binary_length = other_items_binary_length + vector::length(item);
            vector::push_back(&mut endless_v.items, *item);
            item_idx = item_idx + 1;
        };

        // Update this_object_items_binary_length
        endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + other_items_binary_length;

        // Handle first_item_is_from_previous_history flag
        if (other_first_item_is_from_previous_history && other_items_len > 0) {
            // The first item in other was a continuation from other's last history item
            // This flag should apply to endless_v now since we've transferred the history
            endless_v.first_item_is_from_previous_history = true;
        };

        // Update total length and binary length
        // Use original values since we didn't use push_back
        endless_v.length = original_length + other_length;
        endless_v.binary_length = original_binary_length + other_binary_length;

        // Clean up other's archive table (should be empty now) and id
        table::destroy_empty(other_archive);
        object::delete(other_id);
    }

    /**
        Appends multiple EndlessVectors to the target EndlessVector by concatenating them one by one.
        Each EndlessVector in the others array will be consumed (destroyed) in the process.
        The vectors are concatenated in order: others[0], then others[1], etc.
    */
    public fun append(endless_v: &mut EndlessVector, mut others: vector<EndlessVector>) {
        // Reverse the vector to process in correct order (since we pop from back)
        vector::reverse(&mut others);

        while (!vector::is_empty(&others)) {
            let other = vector::pop_back(&mut others);
            concat(endless_v, other);
        };

        vector::destroy_empty(others);
    }

    public fun length(endless_v: &EndlessVector): u64 {
        endless_v.length
    }

    public fun size(endless_v: &EndlessVector): u64 {
        endless_v.binary_length
    }

    public fun has_items_from(endless_v: &EndlessVector): u64 {
        endless_v.archived_from_length
    }

    public fun archive(endless_v: &mut EndlessVector, ctx: &mut TxContext) {
        clamp(endless_v, std::option::none()); // move .items to history if any

        let history = std::option::swap(&mut endless_v.history, table::new(ctx));
        let archive_item = EndlessVectorArchive {
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

    public fun burn_archive(endless_v: &mut EndlessVector) {
        if (endless_v.archive_items_count > 0) {
            let last_archive_item = table::remove(&mut endless_v.archive, endless_v.burned_archive_count);
            let EndlessVectorArchive {
                id,
                history,
                archived_at_length: _,
                length,
            } = last_archive_item;
            sui::object::delete(id);
            sui::table::drop(history);

            endless_v.burned_archive_count = endless_v.burned_archive_count + 1;
            endless_v.archived_from_length = endless_v.archived_from_length + length;
        };
    }

    public fun flush(endless_v: &mut EndlessVector) {
        endless_v.items = vector::empty();
        endless_v.first_item_is_from_previous_history = false;
        endless_v.length = 0;
        endless_v.binary_length = 0;
        endless_v.this_object_items_binary_length = 0;

        while (endless_v.history_items_count > 0) {
            let _last_item = table::remove(std::option::borrow_mut(&mut endless_v.history), endless_v.history_items_count - 1);
            endless_v.history_items_count = endless_v.history_items_count - 1;
        };

        endless_v.archived_at_length = 0;
        endless_v.archived_from_length = 0;
        endless_v.burned_archive_count = 0;

        while (endless_v.archive_items_count > 0) {
            let last_archive_item = table::remove(&mut endless_v.archive, endless_v.archive_items_count - 1);
            let EndlessVectorArchive {
                id,
                history,
                archived_at_length: _,
                length: _,
            } = last_archive_item;
            sui::object::delete(id);
            sui::table::drop(history);

            endless_v.archive_items_count = endless_v.archive_items_count - 1;
        };
    }

    /**
        On sui max_pure_argument_size: Some(16 * 1024), ( base64 encoded )
        Means, we can't pass arg larger than ~ 12*1024 bytes
        This workaround allows to pass up to 10*12*1024 bytes per call
        which is more than enough to cover max_tx_size_bytes: Some(128 * 1024) ( remember base64 encoded )
    */
    public fun compose_and_push_back(endless_v: &mut EndlessVector, bytes1: vector<u8>, bytes2: vector<u8>, bytes3: vector<u8>, 
                    bytes4: vector<u8>, bytes5: vector<u8>, bytes6: vector<u8>, 
                    bytes7: vector<u8>, bytes8: vector<u8>, bytes9: vector<u8>,
                    bytes10: vector<u8>) {
        let mut items = vector::empty<u8>();
        vector::append(&mut items, bytes1);
        vector::append(&mut items, bytes2);
        vector::append(&mut items, bytes3);
        vector::append(&mut items, bytes4);
        vector::append(&mut items, bytes5);
        vector::append(&mut items, bytes6);
        vector::append(&mut items, bytes7);
        vector::append(&mut items, bytes8);
        vector::append(&mut items, bytes9);
        vector::append(&mut items, bytes10);

        push_back(endless_v, items);
    }


    public fun push_back(endless_v: &mut EndlessVector, bytes: vector<u8>) {
        let adding_size = vector::length(&bytes);
        if (adding_size > SAFE_INNER_SIZE) {
            abort EChunkIsTooLarge
        };

        if (adding_size + endless_v.this_object_items_binary_length > SAFE_INNER_SIZE) {
            clamp(endless_v, option::some(bytes));
        } else {
            vector::push_back(&mut endless_v.items, bytes);
            endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + adding_size;
            endless_v.binary_length = endless_v.binary_length + adding_size;
            endless_v.length = endless_v.length + 1;
        };
    }

    public fun get_at(endless_v: &EndlessVector, i: u64): vector<u8> {
        // Fast path: no history, get from items directly
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            return get_from_items(endless_v, i)
        };

        // Determine first index that is stored directly in items
        let index_after_history_ends = get_first_not_historied_index(endless_v);

        if (i < index_after_history_ends) {
            // If the index is before the history ends, check if it's in archive or current history
            if (endless_v.archived_at_length > i) {
                // Index is in archived items
                return get_from_archive(endless_v, i)
            };

            return get_from_history(endless_v, i)
        } else {
            if (endless_v.first_item_is_from_previous_history) {
                return get_from_items(endless_v, i - index_after_history_ends + 1)
            } else {
                return get_from_items(endless_v, i - index_after_history_ends)
            }
        };

        abort 0 // Should not reach here
    }

    public fun update_at(endless_v: &mut EndlessVector, i: u64, bytes: vector<u8>) {
        // Check if index is out of bounds
        if (i >= endless_v.length) {
            abort EIndexOutOfBounds
        };

        // Check if index is in archived range
        if (endless_v.archived_at_length > i) {
            abort ECannotUpdateArchivedItem
        };

        // Fast path: no history
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            update_in_items(endless_v, i, bytes);
            return
        };

        // Determine first index that is stored directly in items
        let index_after_history_ends = get_first_not_historied_index(endless_v);

        if (i < index_after_history_ends) {
            // Item is in history
            update_in_history(endless_v, i, bytes);
        } else {
            // Item is in current items
            update_in_items(endless_v, i, bytes);
        };
    }

    fun get_history_item_total_size(history_item: &EndlessVectorHistory): u64 {
        let mut total_size = 0u64;
        let mut idx = 0;
        while (idx < vector::length(&history_item.items)) {
            total_size = total_size + vector::length(vector::borrow(&history_item.items, idx));
            idx = idx + 1;
        };
        total_size
    }

    fun update_in_items(endless_v: &mut EndlessVector, global_index: u64, bytes: vector<u8>) {
        let index_after_history_ends = get_first_not_historied_index(endless_v);

        let local_index = if (endless_v.first_item_is_from_previous_history) {
            global_index - index_after_history_ends + 1
        } else {
            global_index - index_after_history_ends
        };

        if (local_index >= vector::length(&endless_v.items)) {
            abort EIndexOutOfBounds
        };

        // Check if this is the first item and it's a continuation from previous history
        if (local_index == 0 && endless_v.first_item_is_from_previous_history) {
            // Do we ever here?
            abort ECannotUpdateSplitItem
        };

        // Get old size
        let old_item = vector::borrow(&endless_v.items, local_index);
        let old_size = vector::length(old_item);
        let new_size = vector::length(&bytes);

        // Update binary lengths
        if (new_size > old_size) {
            let size_diff = new_size - old_size;

            // Check if update would exceed safe size
            if (endless_v.this_object_items_binary_length + size_diff > SAFE_INNER_SIZE) {
                abort ESizeExceedsLimit
            };

            endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length + size_diff;
            endless_v.binary_length = endless_v.binary_length + size_diff;
        } else if (new_size < old_size) {
            let size_diff = old_size - new_size;
            endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length - size_diff;
            endless_v.binary_length = endless_v.binary_length - size_diff;
        };

        // Update the item
        *vector::borrow_mut(&mut endless_v.items, local_index) = bytes;
    }

    fun update_in_history(endless_v: &mut EndlessVector, global_index: u64, bytes: vector<u8>) {
        // Find the history item
        let history_index = binary_search_history_by_saved_length(endless_v, global_index);
        let history_item = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), history_index);

        let local_index = global_index + vector::length(&history_item.items) - history_item.saved_at_length;

        if (local_index >= vector::length(&history_item.items)) {
            abort EIndexOutOfBounds
        };

        // Check if this item is split
        // Case 1: Last item in this history with continuation bytes
        if (local_index == vector::length(&history_item.items) - 1 && history_item.followed_by_next_bytes > 0) {
            // This is a split item - we need to update both parts
            update_split_item_in_history(endless_v, history_index, bytes);
            return
        };

        // Case 2: First item that is from previous history
        if (local_index == 0 && history_item.first_item_is_from_previous_history) {
            abort ECannotUpdateSplitItem
        };

        // Get old size
        let old_item = vector::borrow(&history_item.items, local_index);
        let old_size = vector::length(old_item);
        let new_size = vector::length(&bytes);

        // Check if update would exceed SAFE_INNER_SIZE for this history segment
        if (new_size > old_size) {
            let size_diff = new_size - old_size;
            let total_size = get_history_item_total_size(history_item);

            // Check if adding the size difference would exceed the limit
            if (total_size + size_diff > SAFE_INNER_SIZE) {
                abort ESizeExceedsLimit
            };
        };

        // Update binary_length
        if (new_size > old_size) {
            endless_v.binary_length = endless_v.binary_length + (new_size - old_size);
        } else if (new_size < old_size) {
            endless_v.binary_length = endless_v.binary_length - (old_size - new_size);
        };

        // Update the item
        *vector::borrow_mut(&mut history_item.items, local_index) = bytes;
    }

    fun update_split_item_in_history(endless_v: &mut EndlessVector, history_index: u64, bytes: vector<u8>) {
        // First, gather information without holding mutable references
        let (old_first_part_size, old_second_part_size, last_index, current_history_total_size) = {
            let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);
            let last_idx = vector::length(&history_item.items) - 1;
            let old_first_size = vector::length(vector::borrow(&history_item.items, last_idx));
            let old_second_size = history_item.followed_by_next_bytes;
            let total_size = get_history_item_total_size(history_item);

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

        // Check if the first part update would exceed SAFE_INNER_SIZE in current history segment
        if (new_first_part_size > old_first_part_size) {
            let first_part_diff = new_first_part_size - old_first_part_size;
            if (current_history_total_size + first_part_diff > SAFE_INNER_SIZE) {
                abort ESizeExceedsLimit
            };
        };

        // Check if the second part update would exceed SAFE_INNER_SIZE in next history segment
        if (continuation_in_next_history && new_second_part_size > old_second_part_size) {
            let second_part_diff = new_second_part_size - old_second_part_size;
            let next_history_item = table::borrow(std::option::borrow(&endless_v.history), history_index + 1);
            let next_total_size = get_history_item_total_size(next_history_item);

            if (next_total_size + second_part_diff > SAFE_INNER_SIZE) {
                abort ESizeExceedsLimit
            };
        };

        // Update the first part in history
        {
            let history_item = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), history_index);
            *vector::borrow_mut(&mut history_item.items, last_index) = new_first_part;
            history_item.followed_by_next_bytes = new_second_part_size;
        };

        // Now update the second part
        if (continuation_in_next_history) {
            // Continuation is in next history item
            let next_history_item = table::borrow_mut(std::option::borrow_mut(&mut endless_v.history), history_index + 1);

            if (new_second_part_size > 0) {
                *vector::borrow_mut(&mut next_history_item.items, 0) = new_second_part;
            } else {
                // If new item doesn't need continuation, set to empty
                *vector::borrow_mut(&mut next_history_item.items, 0) = vector::empty<u8>();
            };
        } else {
            // Continuation is in current items
            if (new_second_part_size > 0) {
                // Check if update would exceed SAFE_INNER_SIZE in current items
                if (new_second_part_size > old_second_part_size) {
                    let second_part_diff = new_second_part_size - old_second_part_size;
                    if (endless_v.this_object_items_binary_length + second_part_diff > SAFE_INNER_SIZE) {
                        abort ESizeExceedsLimit
                    };
                };

                *vector::borrow_mut(&mut endless_v.items, 0) = new_second_part;

                // Update this_object_items_binary_length
                if (new_second_part_size > old_second_part_size) {
                    endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length - old_second_part_size + new_second_part_size;
                } else if (new_second_part_size < old_second_part_size) {
                    endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length - old_second_part_size + new_second_part_size;
                };
            } else {
                *vector::borrow_mut(&mut endless_v.items, 0) = vector::empty<u8>();
                endless_v.this_object_items_binary_length = endless_v.this_object_items_binary_length - old_second_part_size;
            };
        };
    }

    fun get_from_items(endless_v: &EndlessVector, local_index: u64): vector<u8> {
        if (local_index >= vector::length(&endless_v.items)) {
            abort 0 // Index out of bounds
        };
        *vector::borrow(&endless_v.items, local_index)
    }

    fun get_from_history(endless_v: &EndlessVector, global_index: u64): vector<u8> {
        // Binary search to find the correct history item using saved_at_length
        let history_index = binary_search_history_by_saved_length(endless_v, global_index);
        let history_item = table::borrow(std::option::borrow(&endless_v.history), history_index);
        
        // let mut i = 0;
        // if (history_item.first_item_is_from_previous_history) {
        let i =  global_index + vector::length(&history_item.items) - history_item.saved_at_length;
        // } else {
        //     i =  global_index + vector::length(&history_item.items) - history_item.saved_at_length;
        // };

        if (i < vector::length(&history_item.items) - 1 || history_item.followed_by_next_bytes == 0) {
            return (*vector::borrow(&history_item.items, i))
        };

        // there's chunk in the next history item or in the first item of the endless_v.items
        let mut result = *vector::borrow(&history_item.items, i);

        let continuation = if (history_index + 1 < endless_v.history_items_count) {
            let next_history = table::borrow(std::option::borrow(&endless_v.history), history_index + 1);
            *vector::borrow(&next_history.items, 0)
        } else if (endless_v.first_item_is_from_previous_history && vector::length(&endless_v.items) > 0) {
            *vector::borrow(&endless_v.items, 0)
        } else {
            abort 0 // No continuation available
        };

        vector::append(&mut result, continuation);

        return result
    }

    fun get_from_archive(endless_v: &EndlessVector, global_index: u64): vector<u8> {
        if (endless_v.burned_archive_count > 0 && global_index < endless_v.archived_from_length) {
            abort EArchiveHasBeenBurned // This part of archive has been burned
        };

        // Binary search to find the correct archive item
        let archive_index = binary_search_archive_by_archived_length(endless_v, global_index);
        let archive_item = table::borrow(&endless_v.archive, archive_index);
        // Now search within the archive's history using the same logic as get_from_history
        let history_index = binary_search_archive_history_by_saved_length(archive_item, global_index);
        let history_item = table::borrow(&archive_item.history, history_index);
        
        let i = global_index + vector::length(&history_item.items) - history_item.saved_at_length;

        if (i < vector::length(&history_item.items) - 1 || history_item.followed_by_next_bytes == 0) {
            return (*vector::borrow(&history_item.items, i))
        };

        // there's chunk in the next history item within the archive
        let mut result = *vector::borrow(&history_item.items, i);

        let continuation = if (history_index + 1 < table::length(&archive_item.history)) {
            let next_history = table::borrow(&archive_item.history, history_index + 1);
            *vector::borrow(&next_history.items, 0)
        } else {
            abort 0 // No continuation available within archive
        };

        vector::append(&mut result, continuation);

        return result
    }

    fun binary_search_archive_by_archived_length(endless_v: &EndlessVector, target_index: u64): u64 {
        // Find the archive item that contains target_index using binary search
        // Each archive contains items up to its archived_at_length
        
        if (endless_v.archive_items_count == 0) {
            abort 0 // No archive items available
        };
        
        let mut left = endless_v.burned_archive_count; // default - 0, > 0 if some archive items have been burned from the start
        let mut right = endless_v.archive_items_count - 1;
        
        while (left <= right) {
            let mid = left + (right - left) / 2;
            let archive_item = table::borrow(&endless_v.archive, mid);
            
            // Get the range this archive covers
            let archive_start = archive_item.archived_at_length - archive_item.length;
            //  if (mid == 0) { 0 } else { 
            //     let prev_archive = table::borrow(&endless_v.archive, mid - 1);
            //     // Find the maximum saved_at_length in previous archive
            //     let mut max_length = 0;
            //     let mut hist_idx = 0;
            //     while (hist_idx < table::length(&prev_archive.history)) {
            //         let hist = table::borrow(&prev_archive.history, hist_idx);
            //         if (hist.saved_at_length > max_length) {
            //             max_length = hist.saved_at_length;
            //         };
            //         hist_idx = hist_idx + 1;
            //     };
            //     max_length
            // };
            
            // Find the maximum saved_at_length in current archive
            let archive_end = archive_item.archived_at_length;
            // let mut archive_end = 0;
            // let mut hist_idx = 0;
            // while (hist_idx < table::length(&archive_item.history)) {
            //     let hist = table::borrow(&archive_item.history, hist_idx);
            //     if (hist.saved_at_length > archive_end) {
            //         archive_end = hist.saved_at_length;
            //     };
            //     hist_idx = hist_idx + 1;
            // };
            
            if (target_index >= archive_start && target_index < archive_end) {
                return mid
            } else if (target_index < archive_start) {
                if (mid == 0) break;
                right = mid - 1;
            } else {
                left = mid + 1;
            };
            
            // Prevent infinite loop in case of u64 wraparound
            if (right == 0 && left > right) {
                break
            };
        };
        
        // Should not reach here if target_index is valid
        abort 0 // Index not found in archive
    }

    fun binary_search_archive_history_by_saved_length(archive: &EndlessVectorArchive, target_index: u64): u64 {
        // Find the history item within an archive that contains target_index using binary search
        let history_count = table::length(&archive.history);
        
        if (history_count == 0) {
            abort 0 // No history items in archive
        };
        
        let mut left = 0u64;
        let mut right = history_count - 1;
        
        while (left <= right) {
            let mid = left + (right - left) / 2;
            let history_item = table::borrow(&archive.history, mid);
            
            if (target_index < history_item.saved_at_length) {
                // Check if this is the first item or if target_index >= previous item's saved_at_length
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
                
                // Target is in an earlier history item
                if (mid == 0) {
                    break
                };
                right = mid - 1;
            } else {
                // Target is in a later history item
                left = mid + 1;
            };
            
            // Prevent infinite loop in case of u64 wraparound
            if (right == 0 && left > right) {
                break
            };
        };
        
        // Should not reach here if target_index is valid
        abort 0 // Index not found in archive history
    }

    fun binary_search_history_by_saved_length(endless_v: &EndlessVector, target_index: u64): u64 {
        // Find the history item that contains target_index using binary search
        // saved_at_length represents cumulative count, so:
        // - History item 0: contains indices 0 to (saved_at_length[0] - 1)
        // - History item 1: contains indices saved_at_length[0] to (saved_at_length[1] - 1)
        // - etc.
        
        if (endless_v.history_items_count == 0) {
            return 0
        };
        
        let mut left = 0u64;
        let mut right = endless_v.history_items_count - 1;
        
        while (left <= right) {
            let mid = left + (right - left) / 2;
            let history_item = table::borrow(std::option::borrow(&endless_v.history), mid);
            
            if (target_index < history_item.saved_at_length) {
                // Check if this is the first item or if target_index >= previous item's saved_at_length
                if (mid == 0) {
                    return mid
                };
                
                // let prev_history_item = table::borrow(std::option::borrow(&endless_v.history), mid - 1);
                let history_start_index = if (history_item.first_item_is_from_previous_history) {
                    history_item.saved_at_length - vector::length(&history_item.items) + 1
                } else {
                    history_item.saved_at_length
                };

                if (target_index >= history_start_index) {
                    return mid
                };
                
                // Target is in an earlier history item
                if (mid == 0) {
                    break
                };
                right = mid - 1;
            } else {
                // Target is in a later history item
                left = mid + 1;
            };
            
            // Prevent infinite loop in case of u64 wraparound
            if (right == 0 && left > right) {
                break
            };
        };
        
        // Should not reach here if target_index is valid
        endless_v.history_items_count - 1
    }

    fun get_first_not_historied_index(endless_v: &EndlessVector): u64 {
        if (endless_v.history_items_count == 0 && endless_v.archive_items_count == 0) {
            return 0
        } else if (endless_v.first_item_is_from_previous_history) {
            // first item of endless_v.items is the suffix of the last item in the last history item
            return (endless_v.length - (vector::length(&endless_v.items) - 1))
        }; // else
        
        return (endless_v.length - (vector::length(&endless_v.items)))
    }

    public fun clamp(endless_v: &mut EndlessVector, push_bytes: Option<vector<u8>>) {
        let mut history_item = EndlessVectorHistory {
            items: endless_v.items,
            followed_by_next_bytes: 0,
            first_item_is_from_previous_history: endless_v.first_item_is_from_previous_history,
            saved_at_length: endless_v.length,
        };

        endless_v.first_item_is_from_previous_history = false; // reset it, because we are going to save a new history item

        if (option::is_some(&push_bytes)) {
            let mut bytes = option::destroy_some(push_bytes);

            endless_v.binary_length = endless_v.binary_length + vector::length(&bytes);

            let mut geting_n_of_them = vector::length(&bytes) - (SAFE_INNER_SIZE - endless_v.this_object_items_binary_length); // @aborts if more
            let mut empt = vector::empty<u8>();
            while (geting_n_of_them > 0) {
                let b  = vector::pop_back(&mut bytes);
                vector::push_back(&mut empt, b);
                geting_n_of_them = geting_n_of_them - 1;
            };
            vector::reverse(&mut empt);

            vector::push_back(&mut history_item.items, bytes);
            history_item.followed_by_next_bytes = vector::length(&empt);
            endless_v.this_object_items_binary_length = vector::length(&empt);

            if (endless_v.this_object_items_binary_length > 0) {
                endless_v.items = vector::singleton(empt);
                endless_v.first_item_is_from_previous_history = true;
                endless_v.length = endless_v.length + 1;
            } else {
                endless_v.items = vector::empty();
            };

            history_item.saved_at_length = endless_v.length;
        } else {
            endless_v.items = vector::empty();
            endless_v.this_object_items_binary_length = 0;
        };


        table::add(std::option::borrow_mut(&mut endless_v.history), endless_v.history_items_count, history_item);
        endless_v.history_items_count = endless_v.history_items_count + 1;
    }


    #[test_only]
    const TEST_SENDER_ADDR: address = @0x1;

    #[test]
    fun test_add_a_lot() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let created_endless_v = empty(ts::ctx(&mut scenario));
        transfer::share_object(created_endless_v);

        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v: EndlessVector = ts::take_shared(&scenario);

        let mut test_compare = vector::empty<vector<u8>>();

        let pseudo_random_seed = 312333;
        let max_i = 2902;
        let mut i = 0;
        let mut expected_binary_length = 0;
        while (i < max_i) {
            let mut chunk_length = 1000;
            if (i > 200 && i % 3 == 0) {
                chunk_length = 27; // every 3rd item is smaller
            };
            if (i > 200 && i % 10 == 0) {
                chunk_length = 10240; // every 10th item is larger
            };
            if (i > 200 && i % 120 == 0) {
                chunk_length = 90240; // every 10th item is larger
            };

            let data = pseudo_random_bytes(pseudo_random_seed + i, chunk_length);
            expected_binary_length = expected_binary_length + chunk_length;
            test_compare.push_back(data);
            push_back(&mut endless_v, data);

            i = i + 1;

            assert!(endless_v.length == i, 0);
            assert!(endless_v.binary_length == expected_binary_length, 0);
        
            if (i % 320 == 0) {
                archive(&mut endless_v, ts::ctx(&mut scenario));
            };
        };




        i = 0;
        while (i < max_i) {
            let data_simple = vector::borrow(&test_compare, i);
            let data_endless_v = get_at(&endless_v, i);

            // debug::print(&i);
            // debug::print(&vector::length(data_simple));
            // debug::print(&vector::length(&data_endless_v));
            assert!(vector::length(data_simple) == vector::length(&data_endless_v), 0);
            assert!(vectors_equal(data_simple, &data_endless_v), 0);

            i = i + 1;
        };


        assert!(endless_v.length == max_i, 0); 
        // debug::print(&endless_v.length);
        // debug::print(&endless_v);

        // lets burn some archive items
        burn_archive(&mut endless_v);

        assert!(endless_v.length == max_i, 0); // still the same

        let should_be_items_from_index = has_items_from(&endless_v);

        assert!(should_be_items_from_index > 0, 0); // some items are not available anymore, as first archive item has been burned

        i = should_be_items_from_index;
        while (i < max_i) {
            let data_simple = vector::borrow(&test_compare, i);
            let data_endless_v = get_at(&endless_v, i);
            assert!(vector::length(data_simple) == vector::length(&data_endless_v), 0);
            assert!(vectors_equal(data_simple, &data_endless_v), 0);

            i = i + 1;
        };

        ts::return_shared(endless_v);

        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = EArchiveHasBeenBurned), allow(unused_variable)]
    fun burned_archive_is_not_available() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let created_endless_v = empty(ts::ctx(&mut scenario));
        transfer::transfer(created_endless_v, TEST_SENDER_ADDR);

        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v: EndlessVector = ts::take_from_sender(&scenario);

        let pseudo_random_seed = 312333;
        let chunk_length = 1000;
        push_back(&mut endless_v, pseudo_random_bytes(pseudo_random_seed, chunk_length));

        archive(&mut endless_v, ts::ctx(&mut scenario));

        burn_archive(&mut endless_v);

        let should_fail = get_at(&endless_v, 0); // this item is not available anymore, as first archive item has been burned

        ts::return_to_sender(&scenario, endless_v);
        ts::end(scenario);
    }

    #[test_only]
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


    #[test_only]
    fun vectors_equal<T>(
        v1: &vector<T>,
        v2: &vector<T>
    ): bool {
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

    #[test_only]
    fun u64_to_bytes(x: u64): vector<u8> {
        // little-endian u64 to bytes
        let mut out = vector::empty<u8>();
        let mut shift = 0;
        while (shift < 64) {
            vector::push_back(&mut out, ((x >> shift) & 0xFF) as u8);
            shift = shift + 8;
        };

        out
    }

    #[test]
    fun test_update_at() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        // Test 1: Update items in current vector (no history)
        push_back(&mut endless_v, b"Hello");
        push_back(&mut endless_v, b"World");
        push_back(&mut endless_v, b"Test");

        assert!(endless_v.length == 3, 0);
        let initial_size = endless_v.binary_length;

        // Update with same size
        update_at(&mut endless_v, 0, b"Howdy");
        assert!(get_at(&endless_v, 0) == b"Howdy", 0);
        assert!(endless_v.binary_length == initial_size, 0); // Same size

        // Update with larger size
        update_at(&mut endless_v, 1, b"Universe");
        assert!(get_at(&endless_v, 1) == b"Universe", 0);
        assert!(endless_v.binary_length == initial_size + 3, 0); // +3 bytes

        // Update with smaller size
        update_at(&mut endless_v, 2, b"OK");
        assert!(get_at(&endless_v, 2) == b"OK", 0);
        assert!(endless_v.binary_length == initial_size + 3 - 2, 0); // -2 bytes

        // Test 2: Update items after creating history
        // Add enough data to trigger clamping
        let mut i = 0;
        while (i < 200) {
            push_back(&mut endless_v, pseudo_random_bytes(i, 1000));
            i = i + 1;
        };

        assert!(endless_v.history_items_count > 0, 0); // History should be created

        // Update an item in current items
        let current_index = endless_v.length - 1;
        update_at(&mut endless_v, current_index, b"Updated Current");
        assert!(get_at(&endless_v, current_index) == b"Updated Current", 0);

        // Update an item in history
        update_at(&mut endless_v, 5, b"Updated History");
        assert!(get_at(&endless_v, 5) == b"Updated History", 0);

        // Test 3: Archive and ensure archived items cannot be updated
        archive(&mut endless_v, ts::ctx(&mut scenario));

        // Add more items after archiving
        push_back(&mut endless_v, b"After Archive");

        // Should be able to update recent items
        let recent_index = endless_v.length - 1;
        update_at(&mut endless_v, recent_index, b"Updated Recent");
        assert!(get_at(&endless_v, recent_index) == b"Updated Recent", 0);

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECannotUpdateArchivedItem)]
    fun test_update_archived_item_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        // Add items and create archive
        let mut i = 0;
        while (i < 300) {
            push_back(&mut endless_v, pseudo_random_bytes(i, 1000));
            i = i + 1;
        };

        archive(&mut endless_v, ts::ctx(&mut scenario));

        // Try to update an archived item (should fail)
        update_at(&mut endless_v, 0, b"Should Fail");

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EIndexOutOfBounds)]
    fun test_update_out_of_bounds_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        push_back(&mut endless_v, b"Test");

        // Try to update beyond length (should fail)
        update_at(&mut endless_v, 10, b"Should Fail");

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ESizeExceedsLimit)]
    fun test_update_exceeds_size_limit_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        // Fill almost to SAFE_INNER_SIZE
        push_back(&mut endless_v, pseudo_random_bytes(0, SAFE_INNER_SIZE - 2000));
        push_back(&mut endless_v, pseudo_random_bytes(1, 1000));

        // Try to update the second item to exceed the limit (should fail)
        // Current: (SAFE_INNER_SIZE - 2000) + 1000 = SAFE_INNER_SIZE - 1000
        // After update: (SAFE_INNER_SIZE - 2000) + 2000 = SAFE_INNER_SIZE
        // Difference: +1000 bytes, total would be SAFE_INNER_SIZE - 1000 + 1000 = SAFE_INNER_SIZE
        // We need to exceed, so let's update to 2001 bytes
        update_at(&mut endless_v, 1, pseudo_random_bytes(2, 2001));

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_update_split_item() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        // Add enough data to cause item splitting during clamping
        // We want to create a scenario where the last item in history is split
        // Fill up close to SAFE_INNER_SIZE
        push_back(&mut endless_v, pseudo_random_bytes(0, SAFE_INNER_SIZE - 10000));

        // This next push should trigger clamping and create a split item
        let large_item = pseudo_random_bytes(1, 15000);
        push_back(&mut endless_v, large_item);

        // At this point, item at index 1 should be split across history and current items
        assert!(endless_v.history_items_count > 0, 0);

        // Try to read the split item to verify it's correct
        let original_item = get_at(&endless_v, 1);
        assert!(vector::length(&original_item) == 15000, 0);

        // Now update the split item
        let new_item = pseudo_random_bytes(100, 12000);
        update_at(&mut endless_v, 1, new_item);

        // Verify the update worked
        let updated_item = get_at(&endless_v, 1);
        assert!(vector::length(&updated_item) == 12000, 0);
        assert!(vectors_equal(&updated_item, &pseudo_random_bytes(100, 12000)), 0);

        // Verify we can still read other items
        let item0 = get_at(&endless_v, 0);
        assert!(vector::length(&item0) == SAFE_INNER_SIZE - 10000, 0);

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_update_10000_items() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        ts::next_tx(&mut scenario, TEST_SENDER_ADDR);

        let mut endless_v = empty(ts::ctx(&mut scenario));

        let original_string = b"Hey there Sui Fam!";
        let updated_string = b"Hey, hey, Sui Fam!";

        // Add 10000 items with the same string
        let mut i = 0;
        while (i < 10000) {
            push_back(&mut endless_v, original_string);
            i = i + 1;
        };

        assert!(endless_v.length == 10000, 0);

        // Update all 10000 items to the new string
        i = 0;
        while (i < 10000) {
            update_at(&mut endless_v, i, updated_string);
            i = i + 1;
        };

        // Verify all items have been updated correctly
        i = 0;
        while (i < 10000) {
            let item = get_at(&endless_v, i);
            assert!(vectors_equal(&item, &updated_string), 0);
            i = i + 1;
        };

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }


    #[test]
    fun test_concat() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        // Create first EndlessVector with data
        let mut endless_v1 = empty(ctx);

        // Add items to v1 - enough to trigger history
        let mut i = 0;
        while (i < 150) {
            let data = pseudo_random_bytes(i, 2000); // 2KB per item
            push_back(&mut endless_v1, data);
            i = i + 1;
        };

        let v1_length = endless_v1.length;
        let v1_binary_length = endless_v1.binary_length;

        // Create second EndlessVector with data
        let mut endless_v2 = empty(ctx);

        // Add items to v2 - also trigger history
        i = 0;
        while (i < 130) {
            let data = pseudo_random_bytes(i + 100, 2000); // Different data
            push_back(&mut endless_v2, data);
            i = i + 1;
        };

        let v2_length = endless_v2.length;
        let v2_binary_length = endless_v2.binary_length;

        // Concatenate v2 into v1
        concat(&mut endless_v1, endless_v2);

        // Verify total length and binary length
        assert!(endless_v1.length == v1_length + v2_length, 0);
        assert!(endless_v1.binary_length == v1_binary_length + v2_binary_length, 1);

        // Verify first 150 items (from v1)
        i = 0;
        while (i < 150) {
            let expected_data = pseudo_random_bytes(i, 2000);
            let actual_data = get_at(&endless_v1, i);
            assert!(vectors_equal(&actual_data, &expected_data), 2);
            i = i + 1;
        };

        // Verify next 130 items (from v2, now at indices 150-279)
        i = 0;
        while (i < 130) {
            let expected_data = pseudo_random_bytes(i + 100, 2000);
            let actual_data = get_at(&endless_v1, i + 150);
            assert!(vectors_equal(&actual_data, &expected_data), 3);
            i = i + 1;
        };

        transfer::transfer(endless_v1, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECannotConcatWithArchivedItems)]
    fun test_concat_with_archived_items_fails() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        // Create first EndlessVector
        let mut endless_v1 = empty(ctx);
        push_back(&mut endless_v1, b"Vector 1");

        // Create second EndlessVector with archived items
        let mut endless_v2 = empty(ctx);

        // Add items to v2
        let mut i = 0;
        while (i < 100) {
            let data = pseudo_random_bytes(i, 2000);
            push_back(&mut endless_v2, data);
            i = i + 1;
        };

        // Archive v2 to create archived items
        archive(&mut endless_v2, ctx);

        // Add more items to v2 after archiving
        push_back(&mut endless_v2, b"After archive");

        // Try to concat v2 (which has archived items) into v1
        // This should fail with ECannotConcatWithArchivedItems
        concat(&mut endless_v1, endless_v2);

        transfer::transfer(endless_v1, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_append_multiple_vectors() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        // Create first EndlessVector (target)
        let mut endless_v1 = empty(ctx);
        push_back(&mut endless_v1, b"Vector 1 - Item 1");
        push_back(&mut endless_v1, b"Vector 1 - Item 2");

        let v1_length = endless_v1.length;
        let v1_binary_length = endless_v1.binary_length;

        // Create second EndlessVector
        let mut endless_v2 = empty(ctx);
        push_back(&mut endless_v2, b"Vector 2 - Item 1");
        push_back(&mut endless_v2, b"Vector 2 - Item 2");

        let v2_length = endless_v2.length;
        let v2_binary_length = endless_v2.binary_length;

        // Create third EndlessVector
        let mut endless_v3 = empty(ctx);
        push_back(&mut endless_v3, b"Vector 3 - Item 1");
        push_back(&mut endless_v3, b"Vector 3 - Item 2");
        push_back(&mut endless_v3, b"Vector 3 - Item 3");

        let v3_length = endless_v3.length;
        let v3_binary_length = endless_v3.binary_length;

        // Prepare vector of EndlessVectors to append
        let mut others = vector::empty<EndlessVector>();
        vector::push_back(&mut others, endless_v2);
        vector::push_back(&mut others, endless_v3);

        // Append all vectors to v1
        append(&mut endless_v1, others);

        // Verify total length and binary length
        assert!(endless_v1.length == v1_length + v2_length + v3_length, 0);
        assert!(endless_v1.binary_length == v1_binary_length + v2_binary_length + v3_binary_length, 1);

        // Verify we can access items from all vectors
        assert!(get_at(&endless_v1, 0) == b"Vector 1 - Item 1", 2);
        assert!(get_at(&endless_v1, 1) == b"Vector 1 - Item 2", 3);
        assert!(get_at(&endless_v1, 2) == b"Vector 2 - Item 1", 4);
        assert!(get_at(&endless_v1, 3) == b"Vector 2 - Item 2", 5);
        assert!(get_at(&endless_v1, 4) == b"Vector 3 - Item 1", 6);
        assert!(get_at(&endless_v1, 5) == b"Vector 3 - Item 2", 7);
        assert!(get_at(&endless_v1, 6) == b"Vector 3 - Item 3", 8);

        transfer::transfer(endless_v1, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

    #[test]
    fun test_empty_and_push() {
        let mut scenario = ts::begin(TEST_SENDER_ADDR);
        let ctx = ts::ctx(&mut scenario);

        // Prepare test data
        let mut items = vector::empty<vector<u8>>();
        vector::push_back(&mut items, b"Item 1");
        vector::push_back(&mut items, b"Item 2");
        vector::push_back(&mut items, b"Item 3");

        // Create vector with items using empty_and_push
        let endless_v = empty_and_push(items, ctx);

        // Verify length
        assert!(endless_v.length == 3, 0);

        // Calculate expected binary length (6 + 6 + 6 = 18 bytes)
        assert!(endless_v.binary_length == 18, 1);

        // Verify items
        assert!(get_at(&endless_v, 0) == b"Item 1", 2);
        assert!(get_at(&endless_v, 1) == b"Item 2", 3);
        assert!(get_at(&endless_v, 2) == b"Item 3", 4);

        transfer::transfer(endless_v, TEST_SENDER_ADDR);
        ts::end(scenario);
    }

}