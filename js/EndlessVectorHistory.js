
import EndlessVectorItem from './EndlessVectorItem.js';

/**
 * @typedef {import('@mysten/sui/grpc').SuiGrpcClient} SuiGrpcClient
 * @typedef {import('./EndlessVector.js').default} EndlessVector
 * @typedef {import('./EndlessVectorArchive.js').default} EndlessVectorArchive
 */

/**
 * Represents a history item in an EndlessVector, managing a segment of the vector's data.
 * Each history item stores a portion of the vector's elements and maintains metadata
 * about its position and relationships with adjacent history items.
 */
export default class EndlessVectorHistory {
    /**
     * Creates a new EndlessVectorHistory instance.
     * @param {Object} params - Configuration parameters
     * @param {SuiGrpcClient} [params.suiClient] - Sui gRPC client instance for blockchain interactions
     * @param {string} [params.id] - Unique identifier for this history item
     * @param {number} [params.index=0] - Index position of this history item in the sequence
     * @param {?Object} [params.fields] - Raw field data from the blockchain object
     * @param {EndlessVector} [params.endlessVector] - Reference to the parent EndlessVector instance
     * @param {?EndlessVectorArchive} [params.endlessVectorArchive] - Reference to the parent EndlessVectorArchive instance
     */
    constructor(params = {}) {
        /** @type {SuiGrpcClient} */
        this.suiClient = params.suiClient;
        /** @type {string} */
        this.id = params.id;
        /** @type {number} */
        this.index = params.index || 0;

        /** @type {?Object} */
        this._fields = params.fields || null;
        /** @type {EndlessVector} */
        this._endlessVector = params.endlessVector || null; // parent instance of EndlessVector class
        /** @type {?EndlessVectorArchive} */
        this._endlessVectorArchive = params.endlessVectorArchive || null; // parent instance of EndlessVectorArchive class

        /** @type {boolean} */
        this._isInitialized = false;
    }

    /**
     * Sets the fields data for this history item. Called by loader of EndlessVector.
     * @param {Object} fields - The fields data from the blockchain object
     */
    setFields(fields) {
        this._fields = fields;
    }

    /**
     * Checks if this history item has been initialized and is ready for use.
     * @returns {boolean} True if the history item is initialized
     */
    isReady() {
        return this._isInitialized;
    }

    /**
     * Initializes this history item by loading its data from the blockchain.
     * Uses promise-based synchronization to prevent multiple concurrent initializations.
     * @returns {Promise<boolean>} True when initialization is complete
     */
    async initialize() {
        if (this._isInitialized) {
            return true;
        }
        if (this.__initializationPromise) {
            return await this.__initializationPromise;
        }

        this.__initializationPromiseResolver = null;
        this.__initializationPromise = new Promise((res)=>{ this.__initializationPromiseResolver = res; });

        await this._endlessVector.loadHistoryItem(this);

        this._isInitialized = true;
        this.__initializationPromiseResolver();

        delete this.__initializationPromise;
        delete this.__initializationPromiseResolver;
    }

    /**
     * Gets the last index position that this history item covers.
     * @returns {number|undefined} The ending index (inclusive), or undefined if not available
     */
    get endsAt() {
        if (this._fields && this._fields.saved_at_length) {
            return parseInt(this._fields.saved_at_length) - 1;
        }
    }

    /**
     * Indicates whether the first item in this history contains suffix bytes that should be 
     * added to the last item from the previous history segment.
     * @returns {boolean} True if the first item contains suffix bytes for the previous history
     */
    get firstItemIsFromPreviousHistory() {
        if (this._fields && this._fields.first_item_is_from_previous_history) {
            return this._fields.first_item_is_from_previous_history;
        }
        return false;
    }

    /**
     * Gets the first index position that this history item covers.
     * Calculation adjusts for whether the first item contains suffix bytes for the previous history.
     * @returns {number} The starting index (inclusive)
     */
    get startsAt() {
        let innerItemsCount = 0;
        if (this._fields && this._fields.items && this._fields.items.length) {
            innerItemsCount = this._fields.items.length;
        }
        if (this.firstItemIsFromPreviousHistory) {
            return this.endsAt - innerItemsCount + 2;
        }
        return this.endsAt - innerItemsCount + 1;
    }

    /**
     * Gets the number of bytes from the next history item that should be appended 
     * to the last item in this history segment. This should equal the byte length 
     * of the first item of the next history.
     * @returns {number} Number of bytes to append from the next history item
     */
    get followedByNextBytes() {
        if (this._fields && this._fields.followed_by_next_bytes) {
            return parseInt(this._fields.followed_by_next_bytes);
        }
        return 0;
    }

    /**
     * Retrieves the byte array at the specified index within this history segment.
     * Handles combining items with suffix bytes from the next history when needed.
     * @param {number} i - The index to retrieve
     * @returns {Promise<Uint8Array>} The byte array at the specified index
     * @throws {Error} If the index is out of range for this history item
     */
    async at(i) {
        if (this.startsAt <= i && i <= this.endsAt) {
            let indexInItems = i - this.startsAt;
            if (this.firstItemIsFromPreviousHistory) {
                indexInItems = i - this.startsAt + 1;
            }

            const context = { endlessVector: this._endlessVector, endlessVectorHistory: this };

            if (indexInItems < (this._fields.items.length - 1)) {
                return await EndlessVectorItem.fromGrpcJson(this._fields.items[indexInItems], context).bytes();
            } else if (indexInItems === (this._fields.items.length - 1)) {
                if (this.followedByNextBytes) {
                    // if this item is child of archive, get suffix from next item of archive, otherwise from endless vector
                    const suffix = this._endlessVectorArchive ?
                        (await this._endlessVectorArchive.getSuffixFromHistoryItemOfIndex(this.index + 1)) :
                        (await this._endlessVector.getSuffixFromHistoryItemOfIndex(this.index + 1));

                    if (suffix.length !== this.followedByNextBytes) {
                        throw new Error('suffix bytes length mismatch');
                    }

                    const head = EndlessVectorItem.fromGrpcJson(this._fields.items[indexInItems], context);
                    const tail = new EndlessVectorItem({ type: 'bytes', bytes: suffix });
                    return EndlessVectorItem.concatBytes(head, tail);
                } else {
                    return await EndlessVectorItem.fromGrpcJson(this._fields.items[indexInItems], context).bytes();
                }
            }
        }

        throw new Error('at() is out of range for this history item');
    }

    /**
     * Gets the suffix bytes stored in this history item that should be appended 
     * to the last item of the previous history segment.
     * @returns {Uint8Array} The suffix bytes, or empty array if none stored
     */
    async getSuffixStoredBytes() {
        if (this.firstItemIsFromPreviousHistory) {
            const context = { endlessVector: this._endlessVector, endlessVectorHistory: this };
            return await EndlessVectorItem.fromGrpcJson(this._fields.items[0], context).bytes();
        }
        return new Uint8Array();
    }

}