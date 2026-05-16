import EndlessVectorHistory from './EndlessVectorHistory.js';

/**
 * @typedef {import('@mysten/sui/grpc').SuiGrpcClient} SuiGrpcClient
 * @typedef {import('./EndlessVector.js').default} EndlessVector
 */

export default class EndlessVectorArchive {
    /**
     * Creates a new EndlessVectorArchive instance.
     * @param {Object} params - Configuration parameters
     * @param {SuiGrpcClient} [params.suiClient] - Sui gRPC client instance for blockchain interactions
     * @param {string} [params.id] - ID or address of the EndlessVectorArchive on the Sui blockchain
     * @param {number} [params.index=0] - Index position of this archive item in the sequence
     * @param {EndlessVector} [params.endlessVector] - Reference to the parent EndlessVector instance
     * @param {Object} [params.fields] - Raw field data from the blockchain object
     */
    constructor(params = {}) {
        /** @type {SuiGrpcClient} */
        this.suiClient = params.suiClient;
        /** @type {string} */
        this.id = params.id;
        /** @type {number} */
        this.index = params.index || 0;
        /** @type {?EndlessVector} */
        this._endlessVector = params.endlessVector || null; // parent instance of EndlessVector class

        /** @type {string} */
        this.historyTableId = null; // id of the dynamic field table that contains history items of this EndlessVector
        /** @type {number} */
        this.historyItemsCount = 0; // data from EndlessVectorArchive object .history field
        this._history = {}; // EndlessVectorHistory instances

        /** @type {Array<Uint8Array>} */
        this._items = []; // final items in the archived vector

        /** @type {boolean} */
        this._isInitialized = false;

        this._fields = params.fields || null;
    }

    /**
     * Sets the fields data for this archive item. Called by loader of EndlessVector.
     * @param {Object} fields - The fields data from the blockchain object
     */
    setFields(fields) {
        this._fields = fields;
        this.historyTableId = fields?.history?.id;
        this.historyItemsCount = parseInt(fields?.history?.size || '0');
    }

    /**
     * Checks if this archive item has been initialized and is ready for use.
     * @returns {boolean} True if the archive item is initialized
     */
    isReady() {
        return this._isInitialized;
    }

    /**
     * Gets the total number of items stored in this archive.
     * @returns {number} The length of the archived vector segment
     */
    get length() {
        if (this._fields && this._fields.length) {
            return parseInt(this._fields.length);
        }
        return 0;
    }

    /**
     * Gets the first index position that this archive covers.
     * @returns {number} The starting index (inclusive)
     */
    get startsAt() {
        return this.endsAt - this.length + 1;
    }

    /**
     * Gets the last index position that this archive covers.
     * @returns {number|undefined} The ending index (inclusive), or undefined if not available
     */
    get endsAt() {
        if (this._fields && this._fields.archived_at_length) {
            return parseInt(this._fields.archived_at_length) - 1;
        }
    }

    /**
     * Initializes this archive item by loading its data from the blockchain.
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

        await this._endlessVector.loadArchiveItem(this);

        this._isInitialized = true;
        this.__initializationPromiseResolver();

        delete this.__initializationPromise;
        delete this.__initializationPromiseResolver;
    }

    /**
     * Gets a history item within this archive by its index.
     * @param {number|string} historyIndex - The index of the history item to retrieve
     * @returns {Promise<EndlessVectorHistory>} The history item at the specified index
     * @throws {Error} If historyTableId is not set or history item not found
     */
    async getHistory(historyIndex) {
        // @todo: check by historyItemsCount 

        const historyIndexInt = parseInt(historyIndex);

        if (this._history[historyIndexInt]) {
            await this._history[historyIndexInt].initialize();
            return this._history[historyIndexInt];
        }

        // go throught the dynamic fields of the history table to find the id of the needed history item
        if (!this.historyTableId) {
            throw new Error('historyTableId is not set');
        }

        let cursor = undefined;
        let haveToLookMore = true;

        do {
            const resp = await this.suiClient.listDynamicFields({ parentId: this.historyTableId, cursor });
            for (const df of resp.dynamicFields ?? []) {
                if (df?.fieldId) {
                    const itemHistoryIndex = EndlessVectorArchive._decodeBcsU64(df.name.bcs);
                    const endlessVectorHistory = new EndlessVectorHistory({
                        suiClient: this.suiClient,
                        id: df.fieldId,
                        index: itemHistoryIndex,
                        endlessVector: this._endlessVector,
                        endlessVectorArchive: this,
                    });
                    this._history[itemHistoryIndex] = endlessVectorHistory;
                    if (itemHistoryIndex === historyIndexInt) {
                        haveToLookMore = false;
                    }
                }
            }
            cursor = resp.cursor;
            if (!resp.hasNextPage) break;
        } while (haveToLookMore);

        if (!this._history[historyIndexInt]) {
            throw new Error(`History not found for index ${historyIndexInt}`);
        }

        await this._history[historyIndexInt].initialize();

        return this._history[historyIndexInt];
    }

    /**
     * Retrieves the byte array at the specified index within this archive.
     * @param {number} i - The index to retrieve
     * @returns {Promise<Uint8Array>} The byte array at the specified index
     * @throws {Error} If the index is out of range for this archive item
     */
    async at(i) {
        if (i <= this.endsAt) {
            for (let j = 0; j < this.historyItemsCount; j++) {
                const historyItem = await this.getHistory(j);
                if (j == 0 && i < historyItem.startsAt) {
                    throw new Error('at() is out of range for this archive item');
                }
                if (historyItem.startsAt <= i && i <= historyItem.endsAt) {
                    return historyItem.at(i);
                }
            }
        }

        throw new Error('at() is out of range for this history item');
    }

    /**
     * Gets suffix bytes from a history item at the specified index within this archive.
     * @param {number} i - The history item index
     * @returns {Promise<Uint8Array>} The suffix bytes from the history item
     * @throws {Error} If the index is out of range for this archive item
     */
    static _decodeBcsU64(bcsBytes) {
        const b = bcsBytes instanceof Uint8Array ? bcsBytes : new Uint8Array(bcsBytes);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return Number(dv.getBigUint64(0, true));
    }

    async getSuffixFromHistoryItemOfIndex(i) {
        if (i < this.historyItemsCount) {
            const historyItem = await this.getHistory(i);
            if (historyItem) {
                return await historyItem.getSuffixStoredBytes();
            }
        }

        throw new Error('getSuffixFromHistoryItemOfIndex() is out of range for this archive item');
    }
}