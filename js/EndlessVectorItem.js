/**
 * Represents a single item stored in an EndlessVector.
 *
 * Currently only bytes items are supported. Blob items (Walrus-stored payloads)
 * are recognised and preserved but cannot yet be read — calling bytes() on a
 * blob item throws. This design lets the rest of the SDK work today while
 * leaving a clear extension point for blob support.
 *
 * gRPC JSON shape of EndlessWalrusItem:
 *   bytes item  → { bytes: "<base64>", blob: null,  meta: "<base64>" }
 *   blob  item  → { bytes: null,       blob: {...},  meta: "<base64>" }
 *   empty item  → { bytes: null,       blob: null,  meta: "<base64>" }
 */
export default class EndlessVectorItem {
    /**
     * @param {Object} params
     * @param {'bytes'|'blob'|'empty'} params.type
     * @param {Uint8Array|null} [params.bytes]
     * @param {Object|null} [params.blobData] - raw gRPC blob fields, preserved for future use
     * @param {Uint8Array} [params.meta]
     * @param {import('./EndlessVector.js').default|null} [params.endlessVector] - parent EndlessVector instance
     * @param {import('./EndlessVectorHistory.js').default|null} [params.endlessVectorHistory] - parent EndlessVectorHistory instance
     */
    constructor(params = {}) {
        /** @type {'bytes'|'blob'|'empty'} */
        this.type = params.type || 'empty';
        /** @type {Uint8Array|null} */
        this._bytes = params.bytes || null;
        /** @type {Object|null} */
        this._blobData = params.blobData || null;
        /** @type {Uint8Array} */
        this.meta = params.meta || new Uint8Array();
        /** @type {import('./EndlessVector.js').default|null} */
        this._endlessVector = params.endlessVector || null;
        /** @type {import('./EndlessVectorHistory.js').default|null} */
        this._endlessVectorHistory = params.endlessVectorHistory || null;
    }

    /** @returns {boolean} */
    get isBytes() { return this.type === 'bytes'; }
    /** @returns {boolean} */
    get isBlob()  { return this.type === 'blob'; }
    /** @returns {boolean} */
    get isEmpty() { return this.type === 'empty'; }

    /**
     * Returns the binary size of this item in bytes.
     * For bytes items, returns the byte array length.
     * For blob items, returns the size from on-chain Blob object data.
     * @returns {number}
     */
    get size() {
        if (this.type === 'bytes') return this._bytes?.length || 0;
        if (this.type === 'blob') return parseInt(this._blobData?.size || 0);
        return 0;
    }

    /**
     * Returns the raw bytes payload.
     * @returns {Uint8Array}
     * @throws {Error} If the item is a blob (not yet supported) or empty
     */
    async bytes() {
        if (this.type === 'bytes') return this._bytes;
        if (this.type === 'blob') {
            if (this._endlessVector?.walrus?.readBlobBytes) {
                return await this._endlessVector.walrus.readBlobBytes(this._blobData);
            }
            throw new Error('Blob items require walrusClient or aggregatorUrl to be configured on the EndlessVector');
        }
        throw new Error('Item is empty');
    }

    /**
     * Returns the raw gRPC blob fields for blob items (future Walrus support).
     * @returns {Object|null}
     */
    blobData() {
        return this._blobData;
    }

    /**
     * Parses an EndlessWalrusItem from its gRPC JSON representation.
     *
     * Handles three historical wire formats:
     *   - gRPC JSON struct  { bytes: "<base64>"|null, blob: {...}|null, meta: "<base64>" }
     *   - Legacy base64 string  "<base64>"
     *   - Legacy plain number array  [1, 2, 3]
     *
     * @param {Object|string|number[]|null} raw
     * @param {Object} [context={}]
     * @param {import('./EndlessVector.js').default|null} [context.endlessVector]
     * @param {import('./EndlessVectorHistory.js').default|null} [context.endlessVectorHistory]
     * @returns {EndlessVectorItem}
     */
    static fromGrpcJson(raw, context = {}) {
        if (raw == null) {
            return new EndlessVectorItem({ type: 'empty', ...context });
        }

        // Legacy: plain number array
        if (Array.isArray(raw)) {
            return new EndlessVectorItem({ type: 'bytes', bytes: new Uint8Array(raw), ...context });
        }

        // Legacy: bare base64 string (whole item serialised as base64)
        if (typeof raw === 'string') {
            return new EndlessVectorItem({ type: 'bytes', bytes: new Uint8Array(Buffer.from(raw, 'base64')), ...context });
        }

        // gRPC JSON struct
        const meta = raw.meta
            ? new Uint8Array(Buffer.from(raw.meta, 'base64'))
            : new Uint8Array();

        if (raw.blob != null) {
            return new EndlessVectorItem({ type: 'blob', blobData: raw.blob, meta, ...context });
        }

        if (raw.bytes != null) {
            const bytes = typeof raw.bytes === 'string'
                ? new Uint8Array(Buffer.from(raw.bytes, 'base64'))
                : new Uint8Array(raw.bytes);
            return new EndlessVectorItem({ type: 'bytes', bytes, meta, ...context });
        }

        return new EndlessVectorItem({ type: 'empty', meta, ...context });
    }

    /**
     * Concatenates two bytes items into one. Used when a split item spans two
     * history segments (followed_by_next_bytes / firstItemIsFromPreviousHistory).
     *
     * @param {EndlessVectorItem} head
     * @param {EndlessVectorItem} tail
     * @returns {Uint8Array}
     * @throws {Error} If either item is not a bytes item
     */
    static concatBytes(head, tail) {
        if (head.type !== 'bytes' || tail.type !== 'bytes') {
            throw new Error('concatBytes requires two bytes items');
        }
        const combined = new Uint8Array(head._bytes.length + tail._bytes.length);
        combined.set(head._bytes);
        combined.set(tail._bytes, head._bytes.length);
        return combined;
    }
}
