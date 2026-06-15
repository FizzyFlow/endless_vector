module endless_vector::endless_walrus_item {
    use walrus::blob::Blob;

    const EItemIsEmpty: u64 = 98;
    const EItemHasBlob: u64 = 99;

    /// Bytes attributed to a Blob reference inside this object's `.items`.
    /// The actual blob payload lives in Walrus; we only store a `Blob` handle here,
    /// so the on-object footprint is the size of the reference (256-bit blob_id).
    /// Adjust later if the handle's accounted size changes.
    const BLOB_STORAGE_VOLUME: u64 = 256 / 8;

    public struct EndlessWalrusItem has store {
        bytes: Option<vector<u8>>,
        blob: Option<Blob>,
        /// Per-item arbitrary metadata. Counted in `item_storage_volume` (occupies on-object bytes)
        /// but NOT in `item_binary_length` (which tracks payload size only).
        meta: vector<u8>,
    }

    public fun new_empty_item(): EndlessWalrusItem {
        EndlessWalrusItem { bytes: option::none(), blob: option::none(), meta: vector::empty<u8>() }
    }

    public fun new_bytes_item(bytes: vector<u8>): EndlessWalrusItem {
        EndlessWalrusItem { bytes: option::some(bytes), blob: option::none(), meta: vector::empty<u8>() }
    }

    public fun new_blob_item(blob: Blob): EndlessWalrusItem {
        EndlessWalrusItem { bytes: option::none(), blob: option::some(blob), meta: vector::empty<u8>() }
    }

    public fun item_borrow_meta(item: &EndlessWalrusItem): &vector<u8> {
        &item.meta
    }

    public fun item_set_meta(item: &mut EndlessWalrusItem, new_meta: vector<u8>) {
        item.meta = new_meta;
    }

    public fun item_has_bytes(item: &EndlessWalrusItem): bool {
        option::is_some(&item.bytes)
    }

    public fun item_has_blob(item: &EndlessWalrusItem): bool {
        option::is_some(&item.blob)
    }

    public fun item_is_empty(item: &EndlessWalrusItem): bool {
        option::is_none(&item.bytes) && option::is_none(&item.blob)
    }

    public fun item_borrow_bytes(item: &EndlessWalrusItem): &vector<u8> {
        option::borrow(&item.bytes)
    }

    public fun item_borrow_blob(item: &EndlessWalrusItem): &Blob {
        option::borrow(&item.blob)
    }

    public fun item_borrow_blob_mut(item: &mut EndlessWalrusItem): &mut Blob {
        option::borrow_mut(&mut item.blob)
    }

    /// Bytes actually stored inside this object: full length for the bytes variant,
    /// `BLOB_STORAGE_VOLUME` for the Blob variant (only a reference is kept; data lives in Walrus),
    /// 0 for the empty variant; plus `vector::length(&meta)` for any item.
    public fun item_storage_volume(item: &EndlessWalrusItem): u64 {
        let core = if (option::is_some(&item.bytes)) {
            vector::length(option::borrow(&item.bytes))
        } else if (option::is_some(&item.blob)) {
            BLOB_STORAGE_VOLUME
        } else {
            0
        };
        core + vector::length(&item.meta)
    }

    public fun item_binary_length(item: &EndlessWalrusItem): u64 {
        if (option::is_some(&item.bytes)) {
            vector::length(option::borrow(&item.bytes))
        } else if (option::is_some(&item.blob)) {
            walrus::blob::size(option::borrow(&item.blob))
        } else {
            0
        }
    }

    /// Destroys an item that holds bytes (or is empty) and returns the bytes.
    /// Aborts if the item holds a Blob (Blob lacks `drop`).
    public fun destroy_item_into_bytes(item: EndlessWalrusItem): vector<u8> {
        let EndlessWalrusItem { bytes, blob, meta: _ } = item;
        if (option::is_some(&blob)) {
            abort EItemHasBlob
        };
        option::destroy_none(blob);
        if (option::is_some(&bytes)) {
            option::destroy_some(bytes)
        } else {
            option::destroy_none(bytes);
            abort EItemIsEmpty
        }
    }

    /// Burns the item: drops bytes if any, and burns the Blob (freeing its storage) if any.
    public fun burn_item(item: EndlessWalrusItem) {
        let EndlessWalrusItem { bytes, blob, meta: _ } = item;
        if (option::is_some(&bytes)) {
            let _ = option::destroy_some(bytes);
        } else {
            option::destroy_none(bytes);
        };
        if (option::is_some(&blob)) {
            walrus::blob::burn(option::destroy_some(blob));
        } else {
            option::destroy_none(blob);
        };
    }

    /// Destroys an item that holds a Blob and returns it.
    /// Aborts if the item does not hold a Blob.
    public fun destroy_item_into_blob(item: EndlessWalrusItem): Blob {
        let EndlessWalrusItem { bytes, blob, meta: _ } = item;
        if (option::is_some(&bytes)) {
            let _ = option::destroy_some(bytes);
        } else {
            option::destroy_none(bytes);
        };
        option::destroy_some(blob)
    }
}
