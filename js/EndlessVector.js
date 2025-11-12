import EndlessVectorHistory from './EndlessVectorHistory.js';
import EndlessVectorArchive from './EndlessVectorArchive.js';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import ids from './ids.js';

/**
 * @typedef {import('@mysten/sui/client').SuiClient} SuiClient
 * @typedef {import('@mysten/sui/client').GetObjectParams} GetObjectParams
 * @typedef {import('@mysten/sui/client').GetDynamicFieldsParams} GetDynamicFieldsParams
 */

/**
 * Should accept Transaction as parameter and return executed transaction digest
 * @callback CustomSignAndExecuteTransactionFunction
 * @param {Transaction} tx
 * @returns {Promise<string>}
 */

/**
 * Represents an endless vector data structure that can grow beyond Sui object size limits
 * by storing overflow data in history items. Provides seamless access to all elements regardless
 * of whether they're stored in the current object or historical segments.
 */
export default class EndlessVector {
    /**
     * Creates a new EndlessVector instance.
     * @param {Object} params - Configuration parameters
     * @param {SuiClient} [params.suiClient] - Sui client instance for blockchain interactions
     * @param {string} [params.id] - ID or address of the EndlessVector on the Sui blockchain
     *
     * @param {?string} [params.packageId] - Adds write capability if provided, ID of the Move package containing the EndlessVector module or 'mainnet', 'testnet' to use known IDs
     * @param {?CustomSignAndExecuteTransactionFunction} [params.signAndExecuteTransaction] - Adds write capability if provided, function should accept Sui transaction, sign and submit it to the blockchain and return its digest
     */
    constructor(params = {}) {
        /** @type {SuiClient} */
        this.suiClient = params.suiClient;
        /** @type {string} */
        this.id = params.id;

        /** @type {number} */
        this.binaryLength = 0;
        /** @type {number} */
        this.length = 0;

        /** @type {number} */
        this.historyItemsCount = 0; // data from EndlessVector object fields, how many history items loaded
        /** @type {string} */
        this.historyTableId = null; // id of the dynamic field table that contains history items of this EndlessVector
        /** @type {Object<number, EndlessVectorHistory>} */
        this._history = {}; // EndlessVectorHistory instances

        /** @type {boolean} */
        this.firstItemIsFromPreviousHistory = false; // from EndlessVector.fields.

        /** @type {Array<Uint8Array>} */
        this._items = []; // items in current EndlessVector object,

        /** @type {string} */
        this.archiveTableId = null; // id of the dynamic field table that contains archives of this EndlessVector

        /** @type {number} */
        this.archiveItemsCount = 0; // how many archives exist, from EndlessVector.fields.archive_items_count
        /** @type {Object<number, EndlessVectorArchive>} */
        this._archive = {}; // EndlessVectorArchive instances, key is archive index
        /** @type {number} */
        this.archivedAtLength = 0; // how many items have been archived in total, from EndlessVector.fields.
        /** @type {number} */
        this.archivedFromLength = 0; // from EndlessVector.fields.archived_from_length
        /** @type {number} */
        this.burnedArchiveCount = 0; // from EndlessVector.fields.burned_archive_count

        /** @type {boolean} */
        this._isInitialized = false;

        /** @type {?string} */
        this._packageId = params.packageId || null;

        if (this._packageId == 'mainnet' || !this._packageId && this.suiClient?.network == 'mainnet') {
            this._packageId = ids['mainnet'].packageId;
        } else if (this._packageId == 'testnet' || !this._packageId && this.suiClient?.network == 'testnet') {
            this._packageId = ids['testnet'].packageId;
        }

        /** @type {?CustomSignAndExecuteTransactionFunction} */
        this._signAndExecuteTransaction = params.signAndExecuteTransaction || null;
    }

    /**
     * Static factory method to create a new empty EndlessVector on the blockchain.
     * Creates a new EndlessVector object via the Move contract and returns a wrapped instance.
     *
     * @param {Object} params - Configuration parameters
     * @param {SuiClient} params.suiClient - Sui client instance for blockchain interactions
     * @param {string} params.packageId - ID of the Move package containing the EndlessVector module
     * @param {CustomSignAndExecuteTransactionFunction} params.signAndExecuteTransaction - Function to sign and execute transactions
     * @param {?Array<Uint8Array>} [params.items] - Optional array of Uint8Array items to initialize the vector with. If provided, uses empty_entry_and_push, otherwise uses empty_entry
     * @param {?Object} [params.gasCoin] - Optional gas coin object reference {objectId: string, digest: string, version: string} to use for transaction payment
     * @param {?Object} [params.options] - Optional transaction parameters
     * @param {?Number} [params.options.timeout] - Transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.options.pollIntervalMs] - Poll interval in ms, default 1000
     * @returns {Promise<EndlessVector>} A new EndlessVector instance
     * @throws {Error} If the transaction fails or no EndlessVector object is created
     */
    static async create(params) {
        const { suiClient, packageId, signAndExecuteTransaction, items, gasCoin, options = {} } = params;

        if (!suiClient) {
            throw new Error('suiClient is required');
        }
        if (!packageId) {
            throw new Error('packageId is required');
        }
        if (!signAndExecuteTransaction) {
            throw new Error('signAndExecuteTransaction is required');
        }

        // Create transaction to call empty_entry
        const tx = new Transaction();

        if (gasCoin) {
            tx.setGasPayment([gasCoin]);
        }

        if (items && Array.isArray(items) && items.length) {
            tx.moveCall({
                target: `${packageId}::endless_vector::empty_entry_and_push`,
                arguments: [tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(items))],
            });
        } else {
            tx.moveCall({
                target: `${packageId}::endless_vector::empty_entry`,
                arguments: [],
            });
        }

        // Execute transaction
        const digest = await signAndExecuteTransaction(tx);

        // Wait for transaction to complete
        const transactionBlockResponse = await suiClient.waitForTransaction({
            digest: digest,
            timeout: options.timeout || 30000,
            pollIntervalMs: options.pollIntervalMs || 1000,
            options: {
                showEffects: true,
                showObjectChanges: true,
            },
        });

        if (transactionBlockResponse?.effects?.status?.status !== 'success') {
            throw new Error('Transaction failed to create EndlessVector');
        }

        // Find the created EndlessVector object
        const objectChanges = transactionBlockResponse.objectChanges || [];
        const createdVector = objectChanges.find(
            change => change.type === 'created' &&
                     change.objectType &&
                     change.objectType.includes('endless_vector::EndlessVector')
        );

        if (!createdVector || !createdVector.objectId) {
            throw new Error('Failed to find created EndlessVector object in transaction response');
        }

        // Create and return the EndlessVector instance
        return new EndlessVector({
            suiClient,
            id: createdVector.objectId,
            packageId,
            signAndExecuteTransaction,
        });
    }

    get isWritable() {
        return !!(this._packageId && this._signAndExecuteTransaction);
    }

    /**
    * Creates a transaction to push new byte arrays to the EndlessVector.
    * Note: this method only creates the transaction, it does not sign or execute it.

    * @param {Uint8Array} arr - Array of byte arrays to push
    * @returns {Transaction} The transaction object to be signed and executed
    */
    getPushTransaction(arr, txToAppendTo = null) {
        if (!this._packageId) {
            throw new Error('packageId is required to compose push transaction');
        }

        let tx = txToAppendTo;
        if (!tx) {
            tx = new Transaction();
        }

        const maxArgLength = 12 * 1024;
        if (arr.length < maxArgLength) {
                tx.moveCall({
                        target: `${this._packageId}::endless_vector::push_back`,
                        arguments: [
                            tx.object(this.id),
                            tx.pure(bcs.vector(bcs.u8()).serialize(arr)),
                        ],
                    });
        } else if (arr.length <= 10 * maxArgLength) {
            const N = 10;
            const chunks = [];
            for (let i = 0; i < N; i++) {
                const start = i * maxArgLength;
                const end = start + maxArgLength;

                if (start < arr.length) {
                    chunks.push(arr.slice(start, Math.min(end, arr.length)));
                } else {
                    chunks.push(new Uint8Array()); // empty chunk
                }
            }
            const args = [tx.object(this.id)];
            for (let i = 0; i < N; i++) {
                args.push(tx.pure(bcs.vector(bcs.u8()).serialize(chunks[i])));
            }
            tx.moveCall({
                    target: `${this._packageId}::endless_vector::compose_and_push_back`,
                    arguments: args,
                });
        } else {
            throw new Error('Array too large, max '+(10*maxArgLength)+' bytes supported per single tx');
        }
        return tx;
    }


    /**
     * Pushes new byte array to the EndlessVector, creating and executing the necessary transaction.
     * Requires the instance to be writable (packageId and signAndExecuteTransaction must be provided).
     * @throws {Error} If the instance is not writable or if the transaction fails
     *
     * @param {Uint8Array} arr - Byte array to push
     * @param {?Object} params - Configuration parameters
     * @param {?Number} [params.timeout] - wait for transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.pollIntervalMs] - wait for transaction confirmation poll interval in ms, default 1000
     * @return {Promise<boolean>} True if the push was successful
    */
    async push(arr, params = {}) {
        if (!this.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }
        const tx = this.getPushTransaction(arr);
        const digest = await this._signAndExecuteTransaction(tx);

        const transactionBlockResponse = await this.suiClient.waitForTransaction({
            digest: digest,
            timeout: params.timeout || 30000,
            pollIntervalMs: params.pollIntervalMs || 1000,
            options: { showEffects: true },
        });
        if (transactionBlockResponse?.effects?.status?.status !== 'success') {
            throw new Error('Transaction failed');
        }

        this.reInitialize(); // force re-initialization to load new data

        return true;
    }

    /**
    * Creates a transaction to concatenate EndlessVector(s) into this one.
    * The other EndlessVector(s) will be consumed (destroyed) in the process.
    * Note: this method only creates the transaction, it does not sign or execute it.
    *
    * @param {string|EndlessVector|Array<string|EndlessVector>} other - The ID of the EndlessVector to concatenate, an EndlessVector instance, or an array of IDs/instances
    * @param {Transaction} [txToAppendTo=null] - Optional transaction to append to
    * @returns {Transaction} The transaction object to be signed and executed
    * @throws {Error} If packageId is not set or if the other vector has archived items
    */
    getConcatTransaction(other, txToAppendTo = null) {
        if (!this._packageId) {
            throw new Error('packageId is required to compose concat transaction');
        }

        let tx = txToAppendTo;
        if (!tx) {
            tx = new Transaction();
        }

        // Check if other is an array - if so, use append, otherwise use concat
        if (Array.isArray(other)) {
            // Extract IDs from EndlessVector instances or use as strings
            const otherIds = other.map(item =>
                (typeof item === 'object' && item.id) ? item.id : item
            );

            // Create a vector of objects to pass to the Move function
            const objectRefs = otherIds.map(id => tx.object(id));

            tx.moveCall({
                target: `${this._packageId}::endless_vector::append`,
                arguments: [
                    tx.object(this.id),
                    tx.makeMoveVec({ elements: objectRefs }),
                ],
            });
        } else {
            // Extract ID if other is an EndlessVector instance, otherwise use as string
            const otherEndlessVectorId = (typeof other === 'object' && other.id) ? other.id : other;

            tx.moveCall({
                target: `${this._packageId}::endless_vector::concat`,
                arguments: [
                    tx.object(this.id),
                    tx.object(otherEndlessVectorId),
                ],
            });
        }

        return tx;
    }

    /**
     * Concatenates EndlessVector(s) into this one, creating and executing the necessary transaction.
     * The other EndlessVector(s) will be consumed (destroyed) in the process.
     * Requires the instance to be writable (packageId and signAndExecuteTransaction must be provided).
     *
     * @param {string|EndlessVector|Array<string|EndlessVector>} other - The ID of the EndlessVector to concatenate, an EndlessVector instance, or an array of IDs/instances to append
     * @param {?Object} params - Configuration parameters
     * @param {?Number} [params.timeout] - wait for transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.pollIntervalMs] - wait for transaction confirmation poll interval in ms, default 1000
     * @return {Promise<boolean>} True if the concat was successful
     * @throws {Error} If the instance is not writable, if the transaction fails, or if any vector has archived items
    */
    async concat(other, params = {}) {
        if (!this.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        const tx = this.getConcatTransaction(other);
        const digest = await this._signAndExecuteTransaction(tx);

        const transactionBlockResponse = await this.suiClient.waitForTransaction({
            digest: digest,
            timeout: params.timeout || 30000,
            pollIntervalMs: params.pollIntervalMs || 1000,
            options: { showEffects: true },
        });
        if (transactionBlockResponse?.effects?.status?.status !== 'success') {
            throw new Error('Transaction failed');
        }

        this.reInitialize(); // force re-initialization to load new data

        return true;
    }

    /**
     * Gets the first index that is stored in the current EndlessVector object (not in history items).
     * @returns {number} The index where current items begin
     */
    get firstNotHistoryIndex() {
        if (this.length === 0) {
            return 0;
        }
        if (this.historyItemsCount === 0 && this.archiveItemsCount === 0) {
            return 0;
        }
        if (this.firstItemIsFromPreviousHistory) {
            return this.length - (this._items.length - 1);
        }
        return this.length - this._items.length;
    }

    /**
     * Forces re-initialization of the EndlessVector to reload data from the blockchain.
     */
    reInitialize() {
        this._isInitialized = false; // force re-initialization to load new data
        this._items = []; // clear current items cache
    }

    /**
     * Initializes the EndlessVector by loading data from the Sui blockchain.
     * Fetches the main object data and all associated history items.
     * @returns {Promise<void>}
     * @throws {Error} If suiClient or id is not provided
     */
    async initialize() {
        if (this._isInitialized) {
            return;
        }
        if (!this.suiClient) {
            throw new Error('suiClient is required');
        }
        if (!this.id) {
            throw new Error('id is required');
        }
    
        // prevent multiple concurrent initializations
        if (this.__initializationPromise) {
            return await this.__initializationPromise;
        }

        this.__initializationPromiseResolver = null;
        this.__initializationPromise = new Promise((res)=>{ this.__initializationPromiseResolver = res; });

        /** @type {GetObjectParams} */
        const getObjectParams = {
            id: this.id,
            options: {
                showContent: true,
            },
        };
        const endlessVectorObjectResponse = await this.suiClient.getObject(getObjectParams);
        const endlessVectorObject = endlessVectorObjectResponse.data?.content?.fields;

        this.binaryLength = parseInt(endlessVectorObject?.binary_length || 0);
        this.length = parseInt(endlessVectorObject?.length || 0);
        this.historyItemsCount = parseInt(endlessVectorObject?.history_items_count || 0);
        this.firstItemIsFromPreviousHistory = (endlessVectorObject?.first_item_is_from_previous_history) || false;
        this.archivedAtLength = parseInt(endlessVectorObject?.archived_at_length || 0);
        this.archiveItemsCount = parseInt(endlessVectorObject?.archive_items_count || 0);

        this.archivedFromLength = parseInt(endlessVectorObject?.archived_from_length || 0);
        this.burnedArchiveCount = parseInt(endlessVectorObject?.burned_archive_count || 0);

        this._items = [];
        if (endlessVectorObject?.items && endlessVectorObject.items.length) {
            for (const item of endlessVectorObject.items) {
                this._items.push(new Uint8Array(item));
            }
        }

        this.archiveTableId = endlessVectorObject?.archive?.fields?.id?.id;
        this.historyTableId = endlessVectorObject?.history?.fields?.id?.id;

        this._isInitialized = true;
        this.__initializationPromiseResolver();

        delete this.__initializationPromise;
        delete this.__initializationPromiseResolver;
    }



    /**
     * Gets a history item by its index, loading it from the blockchain if needed.
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

        /** @type {GetDynamicFieldsParams} */
        const getDynamicFieldsParams  = {
            parentId: this.historyTableId,
            options: {
                showContent: true,
                showType: true,
            },
        };

        let resp = null;
        let haveToLookMore = true;

        do {
            resp  = await this.suiClient.getDynamicFields(getDynamicFieldsParams);
            if (resp && resp.data && resp.data.length) {
                for (const df of resp.data) {
                    if (df?.objectId) {
                        const itemHistoryIndex = parseInt(df.name.value);
                        const endlessVectorHistory = new EndlessVectorHistory({
                            suiClient: this.suiClient,
                            id: df.objectId,
                            index: itemHistoryIndex,
                            endlessVector: this,
                        });
                        this._history[itemHistoryIndex] = endlessVectorHistory;
                        if (itemHistoryIndex === historyIndexInt) {
                            haveToLookMore = false;
                        }
                    }
                }
                getDynamicFieldsParams.cursor = resp.nextCursor;
            }
        } while (resp?.hasNextPage && haveToLookMore);

        if (!this._history[historyIndexInt]) {
            throw new Error(`History not found for index ${historyIndexInt}`);
        }

        await this._history[historyIndexInt].initialize();

        return this._history[historyIndexInt];
    }


    /**
     * Gets an archive item by its index, loading it from the blockchain if needed.
     * @param {number|string} archiveIndex - The index of the archive item to retrieve
     * @returns {Promise<EndlessVectorArchive>} The archive item at the specified index
     * @throws {Error} If archiveTableId is not set or archive item not found
     */
    async getArchive(archiveIndex) {
        const archiveIndexInt = parseInt(archiveIndex);

        if (this._archive[archiveIndexInt]) {
            await this._archive[archiveIndexInt].initialize();
            return this._archive[archiveIndexInt];
        }

        // go throught the dynamic fields of the archive table to find the id of the needed archive
        if (!this.archiveTableId) {
            throw new Error('archiveTableId is not set');
        }

        /** @type {GetDynamicFieldsParams} */
        const getDynamicFieldsParams  = {
            parentId: this.archiveTableId,
            options: {
                showContent: true,
                showType: true,
            },
        };

        let resp = null;
        let haveToLookMore = true;

        do {
            resp  = await this.suiClient.getDynamicFields(getDynamicFieldsParams);
            if (resp && resp.data && resp.data.length) {
                for (const df of resp.data) {
                    if (df?.objectId) {
                        const itemArchiveIndex = parseInt(df.name.value);
                        const endlessVectorArchive = new EndlessVectorArchive({
                            suiClient: this.suiClient,
                            id: df.objectId,
                            index: itemArchiveIndex,
                            endlessVector: this,
                        });
                        this._archive[itemArchiveIndex] = endlessVectorArchive;
                        if (itemArchiveIndex === archiveIndexInt) {
                            haveToLookMore = false;
                        }
                    }
                }
                getDynamicFieldsParams.cursor = resp.nextCursor;
            }
        } while (resp?.hasNextPage && haveToLookMore);

        if (!this._archive[archiveIndexInt]) {
            throw new Error(`Archive not found for index ${archiveIndexInt}`);
        }

        await this._archive[archiveIndexInt].initialize();

        return this._archive[archiveIndexInt];
    }

    /**
     * Loads multiple history items in a single batch request for efficiency.
     * Uses multiGetObjects to fetch multiple history items in a single blockchain call.
     * @param {Array<EndlessVectorHistory>} historyItems - Array of history items to load
     * @returns {Promise<void>}
     */
    async loadHistoryItemsBunch(historyItems) {
        const ids = historyItems.map(hi => hi.id);
        let results = [];
        try {
            results = await this.suiClient.multiGetObjects({
                ids: ids,
                options: { showContent: true,  },
            });
        } catch(e) {
            console.error(e);
        }

        if (results && results.length) {
            for (const res of results) {
                const fields = res?.data?.content?.fields?.value?.fields;
                const id = res?.data?.content?.fields?.id?.id;

                historyItems.forEach(hi => {
                    if (hi.id === id) {
                        hi.setFields(fields);
                    }
                });
            }
        }
    }

    /**
     * Loads a single history item, batching requests for efficiency.
     * Uses a batching mechanism to group multiple requests within a short time window.
     * Automatically batches up to 50 items per request with a 30ms timeout.
     * @param {EndlessVectorHistory} historyItem - The history item to load
     * @returns {Promise<EndlessVectorHistory>} The loaded history item
     */
    async loadHistoryItem(historyItem) {
        const maxWaitForBunchTimeMs = 30;

        if (historyItem.isReady()) {
            return historyItem;
        }

        if (!this.__historyItemLoaderBunches) {
            this.__historyItemLoaderBunches = [];
            this.__historyItemsAlreadyAskedToLoad = {};
        }

        let lastBunch = null;
        if (this.__historyItemLoaderBunches.length) {
            lastBunch = this.__historyItemLoaderBunches[this.__historyItemLoaderBunches.length - 1];
            if (lastBunch.started) {
                // that bunch is already started to load, so we need a new one
                lastBunch = null;
            }
            if (lastBunch && lastBunch.historyItems.length == 50) {
                // max count per bunch reached, we need a new one
                lastBunch = null;
            }
        }

        const doLoad = async() => {
            clearTimeout(lastBunch.timeout);
            if (lastBunch.historyItems.length < 50) {
                // try to add more items to the bunch
                for (const ind in this._history) {
                    if (this.__historyItemsAlreadyAskedToLoad[this._history[ind].id]) {
                        continue;
                    }
                    if (lastBunch.historyItems.length == 50) {
                        break;
                    }
                    lastBunch.historyItems.push(this._history[ind]);
                    this.__historyItemsAlreadyAskedToLoad[this._history[ind].id] = true;
                }
            }
            lastBunch.started = true;
            await this.loadHistoryItemsBunch(lastBunch.historyItems);
            lastBunch.promiseResolver();
        };

        if (!lastBunch) {
            lastBunch = {
                historyItems: [],
                askedAt: Date.now(),
                started: false,
                promise: null,
                promiseResolver: null,
            };
            lastBunch.promise = new Promise((resolve) => {
                lastBunch.promiseResolver = resolve;
            });
            lastBunch.timeout = setTimeout( async() => {
                doLoad();
            }, maxWaitForBunchTimeMs);
            this.__historyItemLoaderBunches.push(lastBunch);
        }

        lastBunch.historyItems.push(historyItem);
        this.__historyItemsAlreadyAskedToLoad[historyItem.id] = true;

        await lastBunch.promise;

        return historyItem;
    }

    /**
     * Loads multiple archive items in a single batch request for efficiency.
     * Uses multiGetObjects to fetch multiple archive items in a single blockchain call.
     * @param {Array<EndlessVectorArchive>} archiveItems - Array of archive items to load
     * @returns {Promise<void>}
     */
    async loadArchiveItemsBunch(archiveItems) {
        const ids = archiveItems.map(ai => ai.id);
        let results = [];
        try {
            results = await this.suiClient.multiGetObjects({
                ids: ids,
                options: { showContent: true,  },
            });
        } catch(e) {
            console.error(e);
        }

        if (results && results.length) {
            for (const res of results) {
                const fields = res?.data?.content?.fields?.value?.fields;
                const id = res?.data?.content?.fields?.id?.id;

                archiveItems.forEach(ai => {
                    if (ai.id === id) {
                        ai.setFields(fields);
                    }
                });
            }
        }
    }

    /**
     * Loads a single archive item, batching requests for efficiency.
     * Uses a batching mechanism to group multiple requests within a short time window.
     * Automatically batches up to 50 items per request with a 30ms timeout.
     * @param {EndlessVectorArchive} archiveItem - The archive item to load
     * @returns {Promise<EndlessVectorArchive>} The loaded archive item
     */
    async loadArchiveItem(archiveItem) {
        const maxWaitForBunchTimeMs = 30;

        if (archiveItem.isReady()) {
            return archiveItem;
        }

        if (!this.__archiveItemLoaderBunches) {
            this.__archiveItemLoaderBunches = [];
            this.__archiveItemsAlreadyAskedToLoad = {};
        }

        let lastBunch = null;
        if (this.__archiveItemLoaderBunches.length) {
            lastBunch = this.__archiveItemLoaderBunches[this.__archiveItemLoaderBunches.length - 1];
            if (lastBunch.started) {
                // that bunch is already started to load, so we need a new one
                lastBunch = null;
            }
            if (lastBunch &&lastBunch.archiveItems.length == 50) {
                // max count per bunch reached, we need a new one
                lastBunch = null;
            }
        }

        const doLoad = async() => {
            clearTimeout(lastBunch.timeout);
            if (lastBunch.archiveItems.length < 50) {
                // try to add more items to the bunch
                for (const ind in this._archive) {
                    if (this.__archiveItemsAlreadyAskedToLoad[this._archive[ind].id]) {
                        continue;
                    }
                    if (lastBunch.archiveItems.length == 50) {
                        break;
                    }
                    lastBunch.archiveItems.push(this._archive[ind]);
                    this.__archiveItemsAlreadyAskedToLoad[this._archive[ind].id] = true;
                }
            }
            lastBunch.started = true;
            await this.loadArchiveItemsBunch(lastBunch.archiveItems);
            lastBunch.promiseResolver();
        };

        if (!lastBunch) {
            lastBunch = {
                archiveItems: [],
                askedAt: Date.now(),
                started: false,
                promise: null,
                promiseResolver: null,
            };
            lastBunch.promise = new Promise((resolve) => {
                lastBunch.promiseResolver = resolve;
            });
            lastBunch.timeout = setTimeout( async() => {
                doLoad();
            }, maxWaitForBunchTimeMs);
            this.__archiveItemLoaderBunches.push(lastBunch);
        }

        lastBunch.archiveItems.push(archiveItem);
        this.__archiveItemsAlreadyAskedToLoad[archiveItem.id] = true;

        await lastBunch.promise;

        return archiveItem;
    }



    /**
     * Retrieves the byte array at the specified index from either current items or history.
     * @param {number} i - The index to retrieve
     * @returns {Promise<Uint8Array>} The byte array at the specified index
     * @throws {Error} If the index is out of range or cannot be found
     */
    async at(i) {
        await this.initialize();

        if (i < 0 || i >= this.length) {
            throw new Error('at() is out of range. Current length: ' + this.length + ', requested index: ' + i);
        }

        if (i < this.firstNotHistoryIndex) {
            if (i < this.archivedAtLength) {
                // in archive
                if (i < this.archivedFromLength) {
                    throw new Error('at() is out of range, this part of archive has been burned');
                }

                for (let j = this.archiveItemsCount - 1; j >= 0; j--) {
                    // reverse order, so we can burn ealier archives 
                    // @todo: binary search?
                    const archiveItem = await this.getArchive(j);
                    if (archiveItem.startsAt <= i && i <= archiveItem.endsAt) {
                        return await archiveItem.at(i);
                    }
                }
            } else {
                // find history item that contains i
                for (let j = 0; j < this.historyItemsCount; j++) {
                    const historyItem = await this.getHistory(j); // @todo: binary search?
                    if (historyItem.startsAt <= i && i <= historyItem.endsAt) {
                        return await historyItem.at(i);
                    }
                }
            }
        } else {
            // in current items
            if (this.firstItemIsFromPreviousHistory) {
                const indexInItems = i - this.firstNotHistoryIndex + 1;
                return this._items[indexInItems];
            } else {
                const indexInItems = i - this.firstNotHistoryIndex;
                return this._items[indexInItems];
            }
        }


        throw new Error('at() could not find history item for index ' + i);
    }

    /**
     * Gets suffix bytes from a history item at the specified index.
     * Used for combining data across history item boundaries. Returns the suffix bytes
     * stored in the first item of the specified history item, or from the current vector's
     * first item if accessing the boundary between history and current items.
     * @param {number} i - The history item index
     * @returns {Promise<Uint8Array|undefined>} The suffix bytes, or undefined if not found
     */
    async getSuffixFromHistoryItemOfIndex(i) {
        if (i < this.historyItemsCount) {
            const historyItem = await this.getHistory(i);
            if (historyItem) {
                return historyItem.getSuffixStoredBytes();
            }
        } else if (this._history[i - 1] && this.firstItemIsFromPreviousHistory) {
            // if there is no such history item, but previous exists, then suffix is the first item of the EndlessVector object items itself 
            return this._items[0];
        }
    }
}