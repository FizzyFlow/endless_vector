import EndlessVectorHistory from './EndlessVectorHistory.js';
import EndlessVectorArchive from './EndlessVectorArchive.js';
import EndlessVectorItem from './EndlessVectorItem.js';
import EndlessVectorWalrus from './EndlessVectorWalrus.js';
import EndlessVectorSeal from './EndlessVectorSeal.js';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import ids from './ids.js';



/**
 * @typedef {import('@mysten/sui/grpc').SuiGrpcClient} SuiGrpcClient
 * @typedef {import('@mysten/sui/transactions').TransactionResult} TransactionResult
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
     * @param {SuiGrpcClient} [params.suiClient] - gRPC client instance for blockchain interactions
     * @param {string} [params.id] - ID or address of the EndlessVector on the Sui blockchain
     * @param {?string} [params.packageId] - Adds write capability if provided; ID of the Move package or 'mainnet'/'testnet' to use known IDs
     * @param {?CustomSignAndExecuteTransactionFunction} [params.signAndExecuteTransaction] - Adds write capability if provided; must accept a Transaction and return its digest
     * @param {?import('@mysten/walrus').WalrusClient} [params.walrusClient] - Walrus client for blob reads and writes (preferred)
     * @param {?string} [params.publisherUrl] - Walrus publisher HTTP URL for blob uploads (fallback if no walrusClient)
     * @param {?string} [params.aggregatorUrl] - Walrus aggregator HTTP URL for blob reads (fallback if no walrusClient)
     * @param {?string} [params.senderAddress] - Sui address of the transaction sender, required for Walrus blob writes
     * @param {?import('@mysten/seal').SealClient} [params.sealClient] - SealClient for Seal encryption/decryption
     * @param {?import('@mysten/seal').SessionKey} [params.sessionKey] - Pre-built SessionKey for Seal operations
     * @param {?any} [params.signer] - Keypair/signer to mint a SessionKey when needed
     * @param {?number} [params.sealTtlMin=5] - SessionKey TTL in minutes (default: 5)
     */
    constructor(params = {}) {
        /** @type {SuiGrpcClient} */
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

        /** @type {Array<EndlessVectorItem>} */
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

        if (this._packageId == 'mainnet' || (!this._packageId && this.suiClient?.network == 'mainnet')) {
            this._packageId = ids['mainnet'].packageId;
        } else if (this._packageId == 'testnet' || (!this._packageId && this.suiClient?.network == 'testnet')) {
            this._packageId = ids['testnet'].packageId;
        }

        /** @type {?CustomSignAndExecuteTransactionFunction} */
        this._signAndExecuteTransaction = params.signAndExecuteTransaction || null;

        /**
         * EndlessVectorWalrus instance for Walrus blob read/write.
         * Null on plain EndlessVector; set to `this` by EndlessVectorWalrus constructor.
         * @type {?EndlessVectorWalrus}
         */
        this.walrus = new EndlessVectorWalrus({ ...params, endlessVector: this });

        /**
         * EndlessVectorSeal companion. Always present; only "enabled" when sealClient is supplied.
         * @type {EndlessVectorSeal}
         */
        this.seal = new EndlessVectorSeal({ ...params, endlessVector: this });

        /**
         * Raw seal_encrypted_key bytes loaded from the on-chain object during initialize().
         * `null` for unsealed vectors. SDK callers usually don't need to read this directly.
         * @type {?Uint8Array}
         */
        this.sealEncryptedKey = null;
    }

    async isEncrypted() {
        await this.initialize();
        return !!this.sealEncryptedKey;
    }

    /**
     * Static factory method to create a new empty EndlessVector on the blockchain.
     * Creates a new EndlessVector object via the Move contract and returns a wrapped instance.
     *
     * @param {Object} params - Configuration parameters
     * @param {SuiGrpcClient} params.suiClient - Sui gRPC client instance for blockchain interactions
     * @param {string} params.packageId - ID of the Move package containing the EndlessVector module
     * @param {CustomSignAndExecuteTransactionFunction} params.signAndExecuteTransaction - Function to sign and execute transactions
     * @param {?Uint8Array|Uint8Array[]} [params.array] - Optional Uint8Array to initialize the vector with as the first item to get with .at(0)
     * @param {?Object} [params.gasCoin] - Optional gas coin object reference {objectId: string, digest: string, version: string} to use for transaction payment
     * @param {?Object} [params.options] - Optional transaction parameters
     * @param {?Number} [params.options.timeout] - Transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.options.pollIntervalMs] - Poll interval in ms, default 1000
     * @returns {Promise<EndlessVector>} A new EndlessVector instance
     * @throws {Error} If the transaction fails or no EndlessVector object is created
     */
    static async create(params) {
        const { suiClient, packageId, signAndExecuteTransaction, array, gasCoin, options = {} } = params;

        let normalizedPackageId = packageId;
        if (normalizedPackageId == 'mainnet' || (!normalizedPackageId && suiClient?.network == 'mainnet')) {
            normalizedPackageId = ids['mainnet'].packageId;
        } else if (normalizedPackageId == 'testnet' || (!normalizedPackageId && suiClient?.network == 'testnet')) {
            normalizedPackageId = ids['testnet'].packageId;
        }

        if (!suiClient) {
            throw new Error('suiClient is required');
        }
        if (!normalizedPackageId) {
            throw new Error('packageId is required');
        }
        if (!signAndExecuteTransaction) {
            throw new Error('signAndExecuteTransaction is required');
        }

        // Create transaction to call empty_entry
        // Sealed mode requires the vector id (only known after the first tx) to scope the
        // Seal-encrypted AES key. We thus:
        //   tx 1 — create an empty vector
        //   tx 2 — set_seal_encrypted_key
        //   tx 3+ — push initial `array` items (encrypted) via the normal push() path
        // Unsealed mode keeps the single-tx fast path below unchanged.
        const sealRequested = !!params.sealClient;
        const sealItemsToPush = sealRequested ? array : null;
        const useArray = sealRequested ? null : array;

        const tx = new Transaction();

        if (gasCoin) {
            tx.setGasPayment([gasCoin]);
        }

        if (useArray && useArray.length) {
            const array = useArray;
            if ((array instanceof Uint8Array)) {
                // single chunk
                const vectorInput = await EndlessVector.getCreateTransactionAndReturnVectorInput({
                    packageId: normalizedPackageId,
                }, array, tx);
                tx.moveCall({
                    target: `${normalizedPackageId}::endless_walrus::transfer_to_sender`,
                    arguments: [vectorInput],
                });
            } else if (array[0] && (array[0] instanceof Uint8Array)) {
                // multiple chunks
                const vectorInput = await EndlessVector.getCreateTransactionAndReturnVectorInput({
                    packageId: normalizedPackageId,
                }, null, tx);
                for (let i = 0; i < array.length; i++) {
                    EndlessVector.composePushTransaction(normalizedPackageId, vectorInput, array[i], tx);
                }
                tx.moveCall({
                    target: `${normalizedPackageId}::endless_walrus::transfer_to_sender`,
                    arguments: [vectorInput],
                });
            } else {
                throw new Error('.array must be Uint8Array or array of Uint8Array');
            }
        } else {
            tx.moveCall({
                target: `${normalizedPackageId}::endless_walrus::empty_entry`,
                arguments: [],
            });
        }

        // Execute transaction — callback may return a digest string OR a rich tx-data object
        const execResult = await signAndExecuteTransaction(tx);
        const digest = typeof execResult === 'string'
            ? execResult
            : execResult?.digest ?? execResult?.data?.digest;
        if (!digest) throw new Error('signAndExecuteTransaction returned no digest');

        // create() always needs objectTypes to find the new EndlessVector, which the
        // callback's effects don't include — so we always do a waitForTransaction here.
        const txResult = await suiClient.waitForTransaction({
            digest,
            include: { effects: true, objectTypes: true },
            timeout: options.timeout || 30000,
            pollInterval: options.pollIntervalMs || 200,
        });
        const txData = txResult.Transaction ?? txResult.FailedTransaction;
        if (!txData?.status?.success) {
            throw new Error('Transaction failed to create EndlessVector');
        }

        // Find the created EndlessVector object via objectTypes map (gRPC) or fallback objectChanges
        const objectTypes = txData.objectTypes ?? {};
        const createdVector = txData.effects?.changedObjects?.find(
            c => c.idOperation === 'Created' &&
                 (objectTypes[c.objectId] ?? '').includes('endless_walrus::EndlessWalrusVector')
        );

        if (!createdVector?.objectId) {
            throw new Error('Failed to find created EndlessVector object in transaction response');
        }

        // Create the EndlessVector instance
        const ev = new EndlessVector({
            ...params,
            suiClient,
            id: createdVector.objectId,
            packageId: normalizedPackageId,
            signAndExecuteTransaction,
        });

        // Seal layer: generate AES key, Seal-wrap it scoped to the new vector id, attach on-chain.
        // Subsequent push() calls will encrypt every item automatically.
        if (sealRequested) {
            const aesKey = EndlessVectorSeal.generateAesKey();
            ev.seal.setAesKey(aesKey);
            const wrappedKey = await ev.seal.wrapAesKey(aesKey);

            const setKeyTx = new Transaction();
            setKeyTx.moveCall({
                target: `${normalizedPackageId}::endless_walrus::set_seal_encrypted_key`,
                arguments: [
                    setKeyTx.object(ev.id),
                    setKeyTx.pure(bcs.vector(bcs.u8()).serialize(wrappedKey)),
                ],
            });
            await ev.executeAndWaitForTransaction(setKeyTx, options);
            ev.sealEncryptedKey = wrappedKey;

            // Now push any initial items — push() will encrypt them transparently.
            if (sealItemsToPush && sealItemsToPush.length) {
                await ev.push(sealItemsToPush, options);
            }
        }

        return ev;
    }

    /**
     * Creates an empty EndlessVector and returns the vector input reference.
     * Appends vector creation to existing transaction or makes new one.
     * 
     * Returns the vector input reference for use in subsequent move calls as argument or to be transferred.
     *
     * @param {Object} params - Configuration parameters
     * @param {string} params.packageId - The package ID ('mainnet', 'testnet', or explicit package ID)
     * @param {Uint8Array|null} [arr=null] - Optional Uint8Array to push back to the new vector as the first item
     * @param {Transaction|null} [txToAppendTo=null] - Optional existing transaction to append the move calls to
     * @returns {Promise<TransactionResult>} Vector input reference for use in subsequent move calls
     * @throws {Error} Throws if packageId is not provided or invalid
     *
     * @example
     * // Create an empty vector
     * const vectorInput = await EndlessVector.getCreateTransactionAndReturnVectorInput({
     *   packageId: 'mainnet'
     * });
     *
     * @example
     * // Create and populate a vector within an existing transaction
     * const data = new Uint8Array([1, 2, 3, 4]);
     * const tx = new Transaction();
     * const vectorInput = await EndlessVector.getCreateTransactionAndReturnVectorInput({
     *   packageId: contract.id
     * }, data, tx);
     */
    static async getCreateTransactionAndReturnVectorInput(params, arr = null, txToAppendTo = null) {
        const { packageId } = params;
        let normalizedPackageId = packageId;
        if (normalizedPackageId == 'mainnet') {
            normalizedPackageId = ids['mainnet'].packageId;
        } else if (normalizedPackageId == 'testnet') {
            normalizedPackageId = ids['testnet'].packageId;
        }

        if (!normalizedPackageId) {
            throw new Error('packageId is required');
        }
        // Create transaction to call empty_entry

        let tx = txToAppendTo;
        if (!tx) {
            tx = new Transaction();
        }

        const vectorInput = tx.moveCall({
            target: `${normalizedPackageId}::endless_walrus::empty`,
            arguments: [],
        });

        if (arr && arr) {
            EndlessVector.composePushTransaction(normalizedPackageId, vectorInput, arr, tx);
        }

        return vectorInput;
    }

    get isWritable() {
        return !!(this._packageId && this._signAndExecuteTransaction);
    }

    /**
     * Executes a transaction via the configured `_signAndExecuteTransaction` callback and
     * resolves to the tx data containing effects.
     *
     * If the callback already returns an object with `.effects` (e.g. callers that use
     * `WaitForLocalExecution` and pass the full response through), we trust that result
     * and skip an extra `waitForTransaction` poll round-trip. Otherwise we treat the
     * return value as a digest string and poll until the tx lands.
     *
     * @param {Transaction} tx
     * @param {Object} [params]
     * @param {number} [params.timeout=30000]
     * @param {number} [params.pollIntervalMs=200]
     * @param {Object} [params.include={ effects: true }]
     * @returns {Promise<Object>} Resolves to the tx data ({ digest, effects, ... }).
     * @throws {Error} If the callback returns no digest or the tx failed.
     */
    async executeAndWaitForTransaction(tx, params = {}) {
        const result = await this._signAndExecuteTransaction(tx);

        // Rich return: tx data containing effects is already present. Accept either the raw
        // tx data ({ digest, effects, status }) or a wrapper exposing effects via `.data`
        // (e.g. suidouble's SuiTransaction). In either case, skip the extra polling round-trip.
        if (result && typeof result === 'object') {
            const txData = result.effects ? result : (result.data?.effects ? result.data : null);
            if (txData) {
                if (txData.status && txData.status.success === false) {
                    throw new Error('Transaction failed');
                }
                return txData;
            }
        }

        const digest = typeof result === 'string' ? result : result?.digest;
        if (!digest) throw new Error('signAndExecuteTransaction returned no digest');

        const txResult = await this.suiClient.waitForTransaction({
            digest,
            include: params.include ?? { effects: true },
            timeout: params.timeout || 30000,
            pollInterval: params.pollIntervalMs || 200,
        });
        const txData = txResult.Transaction ?? txResult.FailedTransaction;
        if (!txData?.status?.success) {
            throw new Error('Transaction failed');
        }
        return txData;
    }

    /** 
     * Attach move calls to transaction, to push item into endlessvector, handling large arrays by chunking them.
     * This static method can be used to compose transactions for any existing EndlessVector instance:
     * tx.object(vector.id)
     * or newly created one, accepting TransactionResult as vectorInput, see: getCreateTransactionAndReturnVectorInput
     *
     * For arrays smaller than 12KB, it uses a single push_back call.
     * For arrays between 12KB and 120KB, it splits the data into 10 chunks and uses compose_and_push_back.
     *
     * @static
     * @param {string} packageId - The package ID of the Move module containing the endless_vector functions
     * @param {TransactionObjectArgument} vectorInput - The transaction object argument representing the EndlessVector
     * @param {Uint8Array} arr - The byte array to push to the vector
     * @param {Transaction} tx - The transaction object to append the move calls to
     * @returns {Transaction} The transaction object with the push operations added
     * @throws {Error} If the array is larger than 120KB (10 * 12KB) — callers should use push() which falls back to walrus.pushBlob() automatically
     */
    static composePushTransaction(packageId, vectorInput, arr, tx) {
        const maxArgLength = 12 * 1024;
        if (arr.length <= maxArgLength) {
                tx.moveCall({
                        target: `${packageId}::endless_walrus::push_back_bytes`,
                        arguments: [
                            vectorInput,
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
            const args = [vectorInput];
            for (let i = 0; i < N; i++) {
                args.push(tx.pure(bcs.vector(bcs.u8()).serialize(chunks[i])));
            }
            tx.moveCall({
                    target: `${packageId}::endless_walrus::compose_and_push_back`,
                    arguments: args,
                });
        } else {
            throw new Error('Array too large, max '+(10*maxArgLength)+' bytes supported per single tx');
        }

        return tx;
    }


    /**
    * Creates a transaction to push new byte arrays to the EndlessVector.
    * Note: this method only creates the transaction, it does not sign or execute it.

    * @param {Uint8Array|Uint8Array[]} arr - Uint8Array to push
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

        if (arr instanceof Uint8Array) {
            EndlessVector.composePushTransaction(this._packageId, tx.object(this.id), arr, tx);
        } else if (Array.isArray(arr) && arr[0] && (arr[0] instanceof Uint8Array)) {
            for (let i = 0; i < arr.length; i++) {
                EndlessVector.composePushTransaction(this._packageId, tx.object(this.id), arr[i], tx);
            }
        } else {
            throw new Error('.array must be Uint8Array or array of Uint8Array');
        }

        return tx;
    }


    /**
     * Pushes new byte array to the EndlessVector, creating and executing the necessary transaction.
     * Requires the instance to be writable (packageId and signAndExecuteTransaction must be provided).
     * @throws {Error} If the instance is not writable or if the transaction fails
     *
     * @param {Uint8Array|Uint8Array[]} arr - Byte array or array of byte arrays to push
     * @param {?Object} params - Configuration parameters
     * @param {?Number} [params.timeout] - wait for transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.pollIntervalMs] - wait for transaction confirmation poll interval in ms, default 200
     * @return {Promise<boolean>} True if the push was successful
    */
    async push(arr, params = {}) {
        if (!this.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        // When the vector is sealed, transparently encrypt every item before it goes on-chain.
        // Encryption adds 28 bytes (12B nonce + 16B tag), so it can shift items across the
        // 120 KB walrus threshold — encrypt first, then route.
        if (this.sealEncryptedKey && this.seal?.isEnabled) {
            if (arr instanceof Uint8Array) {
                arr = await this.seal.encryptItem(arr);
            } else if (Array.isArray(arr)) {
                const encrypted = [];
                for (const item of arr) encrypted.push(await this.seal.encryptItem(item));
                arr = encrypted;
            }
        }

        const maxBytesPerTx = 10 * 12 * 1024;
        if (arr instanceof Uint8Array && arr.length > maxBytesPerTx) {
            if (!this.walrus) {
                throw new Error('Array too large for a single tx and no Walrus client configured');
            }
            return !!(await this.walrus.pushBlob(arr, params));
        }

        const tx = this.getPushTransaction(arr);
        await this.executeAndWaitForTransaction(tx, params);

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
                target: `${this._packageId}::endless_walrus::append`,
                arguments: [
                    tx.object(this.id),
                    tx.makeMoveVec({ elements: objectRefs }),
                ],
            });
        } else {
            // Extract ID if other is an EndlessVector instance, otherwise use as string
            const otherEndlessVectorId = (typeof other === 'object' && other.id) ? other.id : other;

            tx.moveCall({
                target: `${this._packageId}::endless_walrus::concat`,
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
     * @param {?Number} [params.pollIntervalMs] - wait for transaction confirmation poll interval in ms, default 200
     * @return {Promise<boolean>} True if the concat was successful
     * @throws {Error} If the instance is not writable, if the transaction fails, or if any vector has archived items
    */
    async concat(other, params = {}) {
        if (!this.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        // Sealed vectors hold items encrypted under per-vector AES keys; merging two would
        // require re-encrypting every item under one key. Refuse early.
        if (this.sealEncryptedKey) {
            throw new Error('concat is not supported on sealed vectors');
        }

        const tx = this.getConcatTransaction(other);
        await this.executeAndWaitForTransaction(tx, params);

        this.reInitialize(); // force re-initialization to load new data

        return true;
    }

    /**
     * Creates a transaction to archive the current history of this EndlessVector.
     * Moves all history items into a new archive entry, freeing up history capacity.
     * Note: this method only creates the transaction, it does not sign or execute it.
     *
     * @param {Transaction} [txToAppendTo=null] - Optional transaction to append to
     * @returns {Transaction} The transaction object to be signed and executed
     * @throws {Error} If packageId is not set
     */
    getArchiveTransaction(txToAppendTo = null) {
        if (!this._packageId) {
            throw new Error('packageId is required to compose archive transaction');
        }

        const tx = txToAppendTo ?? new Transaction();

        tx.moveCall({
            target: `${this._packageId}::endless_walrus::archive`,
            arguments: [tx.object(this.id)],
        });

        return tx;
    }

    /**
     * Archives the current history of this EndlessVector, creating and executing the necessary transaction.
     * Moves all history items into a new archive entry to free up history capacity for future pushes.
     * Requires the instance to be writable (packageId and signAndExecuteTransaction must be provided).
     *
     * @param {?Object} params - Configuration parameters
     * @param {?Number} [params.timeout] - wait for transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.pollIntervalMs] - wait for transaction confirmation poll interval in ms, default 200
     * @returns {Promise<boolean>} True if the archive was successful
     * @throws {Error} If the instance is not writable or if the transaction fails
     */
    async archive(params = {}) {
        if (!this.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        const tx = this.getArchiveTransaction();
        await this.executeAndWaitForTransaction(tx, params);

        this.reInitialize();

        return true;
    }

    /**
     * Creates a transaction to burn the oldest archive entry of this EndlessVector.
     * Burned items are permanently deleted and can no longer be read.
     * Note: this method only creates the transaction, it does not sign or execute it.
     *
     * @param {Transaction} [txToAppendTo=null] - Optional transaction to append to
     * @returns {Transaction} The transaction object to be signed and executed
     * @throws {Error} If packageId is not set
     */
    getBurnArchiveTransaction(txToAppendTo = null) {
        if (!this._packageId) {
            throw new Error('packageId is required to compose burn_archive transaction');
        }

        const tx = txToAppendTo ?? new Transaction();

        tx.moveCall({
            target: `${this._packageId}::endless_walrus::burn_archive`,
            arguments: [tx.object(this.id)],
        });

        return tx;
    }

    /**
     * Burns the oldest archive entry of this EndlessVector, creating and executing the necessary transaction.
     * Burned items are permanently deleted and can no longer be read.
     * Requires the instance to be writable (packageId and signAndExecuteTransaction must be provided).
     *
     * @param {?Object} params - Configuration parameters
     * @param {?Number} [params.timeout] - wait for transaction confirmation timeout in ms, default 30000
     * @param {?Number} [params.pollIntervalMs] - wait for transaction confirmation poll interval in ms, default 200
     * @returns {Promise<boolean>} True if the burn was successful
     * @throws {Error} If the instance is not writable or if the transaction fails
     */
    async burnArchive(params = {}) {
        if (!this.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        const tx = this.getBurnArchiveTransaction();
        await this.executeAndWaitForTransaction(tx, params);

        this.reInitialize();

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

        const { object } = await this.suiClient.getObject({ objectId: this.id, include: { json: true } });
        const endlessVectorObject = object?.json;

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
                this._items.push(EndlessVectorItem.fromGrpcJson(item, { endlessVector: this }));
            }
        }

        // In gRPC json, Table<K,V> appears as { id: "0x...", size: "..." } — id is a plain string
        this.archiveTableId = endlessVectorObject?.archive?.id;
        this.historyTableId = endlessVectorObject?.history?.id;

        // seal_encrypted_key is an Option<vector<u8>> on-chain.
        // None → null/undefined; Some(bytes) → base64 string (or array fallback).
        this.sealEncryptedKey = EndlessVector._decodeOptionVectorU8(endlessVectorObject?.seal_encrypted_key);

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

        let cursor = undefined;
        let resp = null;
        let haveToLookMore = true;

        do {
            resp = await this.suiClient.listDynamicFields({ parentId: this.historyTableId, cursor });
            if (resp?.dynamicFields?.length) {
                for (const df of resp.dynamicFields) {
                    if (df.fieldId) {
                        const itemHistoryIndex = EndlessVector._decodeBcsU64(df.name.bcs);
                        const endlessVectorHistory = new EndlessVectorHistory({
                            suiClient: this.suiClient,
                            id: df.fieldId,
                            index: itemHistoryIndex,
                            endlessVector: this,
                        });
                        this._history[itemHistoryIndex] = endlessVectorHistory;
                        if (itemHistoryIndex === historyIndexInt) {
                            haveToLookMore = false;
                        }
                    }
                }
                cursor = resp.cursor;
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

        let cursor = undefined;
        let resp = null;
        let haveToLookMore = true;

        do {
            resp = await this.suiClient.listDynamicFields({ parentId: this.archiveTableId, cursor });
            if (resp?.dynamicFields?.length) {
                for (const df of resp.dynamicFields) {
                    if (df.fieldId) {
                        const itemArchiveIndex = EndlessVector._decodeBcsU64(df.name.bcs);
                        const endlessVectorArchive = new EndlessVectorArchive({
                            suiClient: this.suiClient,
                            id: df.fieldId,
                            index: itemArchiveIndex,
                            endlessVector: this,
                        });
                        this._archive[itemArchiveIndex] = endlessVectorArchive;
                        if (itemArchiveIndex === archiveIndexInt) {
                            haveToLookMore = false;
                        }
                    }
                }
                cursor = resp.cursor;
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
        let objects = [];
        try {
            const res = await this.suiClient.getObjects({ objectIds: ids, include: { json: true } });
            objects = res.objects ?? [];
        } catch(e) {
            console.error(e);
        }

        for (const obj of objects) {
            // Dynamic field Field<K,V>: json = { id: { id: "..." }, name: K, value: V_fields }
            const fields = obj?.json?.value;
            const id = obj?.json?.id?.id ?? obj?.objectId;

            historyItems.forEach(hi => {
                if (hi.id === id) {
                    hi.setFields(fields);
                }
            });
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
        let objects = [];
        try {
            const res = await this.suiClient.getObjects({ objectIds: ids, include: { json: true } });
            objects = res.objects ?? [];
        } catch(e) {
            console.error(e);
        }

        for (const obj of objects) {
            const fields = obj?.json?.value;
            const id = obj?.json?.id?.id ?? obj?.objectId;

            archiveItems.forEach(ai => {
                if (ai.id === id) {
                    ai.setFields(fields);
                }
            });
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
     * For sealed vectors, transparently decrypts the item via the seal companion.
     * @param {number} i - The index to retrieve
     * @returns {Promise<Uint8Array>} The byte array at the specified index
     * @throws {Error} If the index is out of range or cannot be found
     */
    async at(i) {
        const raw = await this._atRaw(i);
        if (this.sealEncryptedKey) {
            return await this.seal.decryptItem(raw);
        }
        return raw;
    }

    /**
     * Raw read of the byte array at the specified index. Returns ciphertext for sealed vectors.
     * Kept separate so `at()` can wrap with optional decryption without rewriting routing.
     * @param {number} i
     * @returns {Promise<Uint8Array>}
     */
    async _atRaw(i) {
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
                return await this._items[indexInItems].bytes();
            } else {
                const indexInItems = i - this.firstNotHistoryIndex;
                return await this._items[indexInItems].bytes();
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
                return await historyItem.getSuffixStoredBytes();
            }
        } else if (this._history[i - 1] && this.firstItemIsFromPreviousHistory) {
            // if there is no such history item, but previous exists, then suffix is the first item of the EndlessVector object items itself
            return await this._items[0].bytes();
        }
    }

    /**
     * Decode a little-endian u64 from a BCS-encoded Uint8Array (gRPC dynamic-field name).
     * @param {Uint8Array} bcsBytes
     * @returns {number}
     */
    /**
     * Decode a (possibly-Option) `vector<u8>` from gRPC json. gRPC serializes binary fields
     * as base64 strings, but other code paths may pass through Uint8Array, plain arrays of
     * bytes, or { vec: [...] } shapes — handle all of them.
     */
    static _decodeOptionVectorU8(value) {
        if (value == null) return null;
        if (value instanceof Uint8Array) return value;
        if (typeof value === 'string') {
            if (!value.length) return null;
            const bin = (typeof Buffer !== 'undefined')
                ? Buffer.from(value, 'base64')
                : Uint8Array.from(atob(value), c => c.charCodeAt(0));
            return new Uint8Array(bin.buffer, bin.byteOffset ?? 0, bin.byteLength ?? bin.length);
        }
        if (Array.isArray(value)) return value.length ? new Uint8Array(value) : null;
        if (typeof value === 'object' && Array.isArray(value.vec)) {
            return value.vec.length ? new Uint8Array(value.vec) : null;
        }
        return null;
    }

    static _decodeBcsU64(bcsBytes) {
        const b = bcsBytes instanceof Uint8Array ? bcsBytes : new Uint8Array(bcsBytes);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return Number(dv.getBigUint64(0, true));
    }
}