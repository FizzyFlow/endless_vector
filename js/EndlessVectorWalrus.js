import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * @typedef {import('@mysten/sui/grpc').SuiGrpcClient} SuiGrpcClient
 * @typedef {import('@mysten/walrus').WalrusClient} WalrusClient
 * @typedef {import('./EndlessVector.js').default} EndlessVector
 */

/**
 * Walrus blob read/write companion for EndlessVector.
 * Attached as `endlessVector.walrus` on every EndlessVector instance.
 * Keeps walrus-specific state separate from the core vector logic.
 */
export default class EndlessVectorWalrus {
    /**
     * @param {Object} params
     * @param {EndlessVector} params.endlessVector - parent EndlessVector instance
     * @param {WalrusClient} [params.walrusClient] - @mysten/walrus WalrusClient instance
     * @param {string} [params.publisherUrl] - Walrus publisher HTTP URL (fallback if no walrusClient)
     * @param {string} [params.aggregatorUrl] - Walrus aggregator HTTP URL for reads
     * @param {string} [params.senderAddress] - Sui address of the transaction sender, required for walrusClient writes
     */
    constructor(params = {}) {
        /** @type {EndlessVector} */
        this._endlessVector = params.endlessVector || null;
        /** @type {?WalrusClient} */
        this._walrusClient = params.walrusClient || null;
        /** @type {?string} */
        this._publisherUrl = params.publisherUrl || null;
        /** @type {?string} */
        this._aggregatorUrl = params.aggregatorUrl || null;
        /** @type {?string} */
        this._senderAddress = params.senderAddress || null;
    }

    /**
     * Reads blob bytes from Walrus for a blob item.
     * Uses walrusClient if available, otherwise falls back to aggregatorUrl.
     * Called automatically by EndlessVectorItem.bytes() for blob items.
     * @param {Object} blobData - raw gRPC blob fields from EndlessWalrusItem
     * @returns {Promise<Uint8Array>}
     * @throws {Error} If no Walrus read transport is configured
     */
    async readBlobBytes(blobData) {
        const blobId = blobData?.blob_id ?? blobData?.blobId;
        if (!blobId) throw new Error('Cannot read blob: blob_id not found in blob data');

        if (this._aggregatorUrl) {
            // gRPC returns blob_id as a decimal u256 string; encode to base64url for the aggregator.
            const blobIdEncoded = EndlessVectorWalrus._encodeBlobId(blobId);
            const res = await fetch(`${this._aggregatorUrl}/v1/blobs/${blobIdEncoded}`);
            if (!res.ok) throw new Error(`Walrus aggregator returned ${res.status} for blob ${blobIdEncoded}`);
            return new Uint8Array(await res.arrayBuffer());
        }

        if (this._walrusClient) {
            return await this._walrusClient.readBlob({ blobId });
        }

        throw new Error('Blob items require walrusClient or aggregatorUrl to be read');
    }

    /**
     * Encodes a blob ID (decimal u256 string or already-encoded string) to Walrus base64url format.
     * If the value is not a pure decimal string, returns it unchanged (already encoded).
     * @param {string} value
     * @returns {string}
     */
    static _encodeBlobId(value) {
        let bytes;
        if (value instanceof Uint8Array) {
            bytes = value;
        } else if (Array.isArray(value)) {
            bytes = new Uint8Array(value);
        } else if (/^\d+$/.test(String(value))) {
            let n = BigInt(value);
            bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                bytes[i] = Number(n & 0xffn);
                n >>= 8n;
            }
        } else {
            return value;
        }
        let b64 = '';
        for (let i = 0; i < bytes.length; i += 3) {
            const a = bytes[i], b = bytes[i + 1] || 0, c = bytes[i + 2] || 0;
            const triplet = (a << 16) | (b << 8) | c;
            const chars = i + 2 < bytes.length ? 4 : (i + 1 < bytes.length ? 3 : 2);
            const encoded = [
                triplet >> 18 & 63, triplet >> 12 & 63, triplet >> 6 & 63, triplet & 63
            ].slice(0, chars).map(v => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[v]).join('');
            b64 += encoded;
        }
        return b64;
    }

    /**
     * Simulates `tx` (devInspect — no signing, no gas, ownership checks disabled) and returns
     * the BCS bytes of the first command's first return value. Used by the on-chain view
     * helpers below.
     * @param {Transaction} tx - a transaction whose first command is the view moveCall
     * @param {string} label - used in error messages
     * @returns {Promise<Uint8Array>}
     * @private
     */
    async _simulateReturnBytes(tx, label) {
        const ev = this._endlessVector;
        // A sender is required to build the transaction for simulation; any address works
        // since `checksEnabled: false` skips ownership/gas validation for these reads.
        const sender = this._senderAddress || ev.suiClient?.address || ZERO_ADDRESS;
        tx.setSenderIfNotSet(sender);

        const sim = await ev.suiClient.simulateTransaction({
            transaction: tx,
            include: { commandResults: true },
            checksEnabled: false,
        });

        if (sim.FailedTransaction) {
            throw new Error(`${label} simulation failed`);
        }

        const returnValue = sim.commandResults?.[0]?.returnValues?.[0];
        if (!returnValue?.bcs) {
            throw new Error(`${label} simulation returned no value`);
        }
        return new Uint8Array(returnValue.bcs);
    }

    /**
     * Reads the minimum Walrus storage `end_epoch` across every Blob held by this vector
     * (current items + history segments + non-burned archive segments), by calling the
     * `endless_walrus::min_blob_end_epoch` view function via transaction simulation
     * (devInspect). No transaction is signed or submitted, so this works on a read-only
     * vector and costs no gas.
     *
     * The on-chain function returns `Option<u32>`; this resolves to `null` when the vector
     * holds no blobs, or the smallest end epoch (a `number`) otherwise.
     *
     * @returns {Promise<number|null>} Minimum blob end epoch, or `null` if there are no blobs
     * @throws {Error} If packageId or the vector id is not set, or the simulation fails
     */
    async minBlobEndEpoch() {
        const ev = this._endlessVector;
        if (!ev._packageId) {
            throw new Error('packageId is required to read min_blob_end_epoch');
        }
        if (!ev.id) {
            throw new Error('vector id is required to read min_blob_end_epoch');
        }

        const tx = new Transaction();
        tx.moveCall({
            target: `${ev._packageId}::endless_walrus::min_blob_end_epoch`,
            arguments: [tx.object(ev.id)],
        });

        // Move return type is Option<u32>: BCS is [0] for none, or [1, <u32-le>] for some.
        const bytes = await this._simulateReturnBytes(tx, 'min_blob_end_epoch');
        const decoded = bcs.option(bcs.u32()).parse(bytes);
        return decoded === null ? null : Number(decoded);
    }

    /**
     * The Walrus System shared object id, resolved from the configured WalrusClient.
     * @returns {Promise<string>}
     * @throws {Error} If no walrusClient is configured
     * @private
     */
    async _getSystemObjectId() {
        if (!this._walrusClient) {
            throw new Error('walrusClient is required to resolve the Walrus System object');
        }
        if (!this.__systemObjectId) {
            const systemObject = await this._walrusClient.systemObject();
            this.__systemObjectId = systemObject.id?.id ?? systemObject.id;
        }
        return this.__systemObjectId;
    }

    /**
     * The current `storage_price_per_unit_size` from on-chain system state (FROST per
     * 1 MiB storage unit per epoch).
     * @returns {Promise<bigint>}
     * @private
     */
    async _getStoragePricePerUnit() {
        if (!this._walrusClient) {
            throw new Error('walrusClient is required to read the storage price');
        }
        const systemState = await this._walrusClient.systemState();
        return BigInt(systemState.storage_price_per_unit_size);
    }

    /**
     * The Move type of a WAL coin (e.g. `0x…::wal::WAL`), derived from the
     * `extend_blobs_to_epoch` Move function signature (its `payment: &mut Coin<WAL>` param).
     * Cached after the first lookup.
     * @returns {Promise<string>}
     * @private
     */
    async _getWalCoinType() {
        const ev = this._endlessVector;
        if (this.__walCoinType) return this.__walCoinType;

        const { function: normalized } = await ev.suiClient.getMoveFunction({
            packageId: ev._packageId,
            moduleName: 'endless_walrus',
            name: 'extend_blobs_to_epoch',
        });

        // params: (&mut EndlessWalrusVector, &mut System, u32 target, &mut Coin<WAL>)
        const param = normalized?.parameters?.[3];
        const typeArg = param?.body?.$kind === 'datatype' ? param.body.datatype.typeParameters?.[0] : undefined;
        const walCoinType = typeArg?.$kind === 'datatype' ? typeArg.datatype.typeName : null;
        if (!walCoinType) {
            throw new Error('could not resolve WAL coin type from extend_blobs_to_epoch signature');
        }

        this.__walCoinType = walCoinType;
        return walCoinType;
    }

    /**
     * Reads the exact WAL cost (in FROST) to bring every blob in this vector up to
     * `targetEndEpoch` via {@link extendBlobsToEpoch}, by calling the
     * `endless_walrus::extend_blobs_cost_to_epoch` view function via simulation (devInspect).
     * Returns `0n` when nothing needs extending.
     *
     * @param {number} targetEndEpoch - the storage end epoch every blob should reach
     * @returns {Promise<bigint>} Required payment in FROST
     * @throws {Error} If packageId/vector id are unset or walrusClient is missing
     */
    async extendBlobsCostToEpoch(targetEndEpoch) {
        const ev = this._endlessVector;
        if (!ev._packageId) {
            throw new Error('packageId is required to read extend_blobs_cost_to_epoch');
        }
        if (!ev.id) {
            throw new Error('vector id is required to read extend_blobs_cost_to_epoch');
        }

        const [systemObjectId, pricePerUnit] = await Promise.all([
            this._getSystemObjectId(),
            this._getStoragePricePerUnit(),
        ]);

        const tx = new Transaction();
        tx.moveCall({
            target: `${ev._packageId}::endless_walrus::extend_blobs_cost_to_epoch`,
            arguments: [
                tx.object(ev.id),
                tx.object(systemObjectId),
                tx.pure.u32(targetEndEpoch),
                tx.pure.u64(pricePerUnit),
            ],
        });

        const bytes = await this._simulateReturnBytes(tx, 'extend_blobs_cost_to_epoch');
        return BigInt(bcs.u64().parse(bytes)); // bcs.u64 parses to a string; normalize to bigint
    }

    /**
     * Builds (without executing) a transaction that extends every blob in this vector up to
     * `targetEndEpoch` in a single `extend_blobs_to_epoch_entry` call. The payment coin is
     * resolved automatically from the sender's WAL balance and the leftover is returned to
     * the sender, unless a `walCoin` is supplied.
     *
     * @param {number} targetEndEpoch - storage end epoch every blob should reach
     * @param {Object} [params={}]
     * @param {bigint} [params.cost] - precomputed cost (FROST); skips the on-chain cost read
     * @param {import('@mysten/sui/transactions').TransactionObjectArgument} [params.walCoin] - WAL coin to pay from; if omitted, one is sourced from the sender's balance
     * @param {Transaction} [params.txToAppendTo=null]
     * @returns {Promise<Transaction>}
     * @throws {Error} If packageId is not set
     */
    async getExtendBlobsToEpochTransaction(targetEndEpoch, params = {}) {
        const ev = this._endlessVector;
        if (!ev._packageId) {
            throw new Error('packageId is required to compose extend_blobs_to_epoch transaction');
        }

        const systemObjectId = await this._getSystemObjectId();
        const tx = params.txToAppendTo ?? new Transaction();

        // Resolve the payment coin: caller-supplied, or sourced from the sender's WAL balance
        // for exactly the required cost.
        let walCoin = params.walCoin ?? null;
        let returnCoin = false;
        if (!walCoin) {
            const cost = params.cost ?? await this.extendBlobsCostToEpoch(targetEndEpoch);
            const walCoinType = await this._getWalCoinType();
            walCoin = tx.add(coinWithBalance({ balance: cost, type: walCoinType }));
            returnCoin = true;
        }

        tx.moveCall({
            target: `${ev._packageId}::endless_walrus::extend_blobs_to_epoch_entry`,
            arguments: [
                tx.object(ev.id),
                tx.object(systemObjectId),
                tx.pure.u32(targetEndEpoch),
                walCoin,
            ],
        });

        // The payment is borrowed (&mut), so the coin object survives the call; return any
        // unspent balance to the sender so it is not left dangling.
        if (returnCoin) {
            const sender = this._senderAddress || ev.suiClient?.address;
            if (!sender) throw new Error('senderAddress is required to return the leftover WAL coin');
            tx.transferObjects([walCoin], sender);
        }

        return tx;
    }

    /**
     * Extends every blob in this vector up to `targetEndEpoch` in a single transaction,
     * signing and executing it via the parent vector. Blobs already valid through the target
     * (and expired blobs, which Walrus cannot extend) are skipped on-chain.
     *
     * @param {number} targetEndEpoch - storage end epoch every blob should reach
     * @param {Object} [params={}] - forwarded to {@link getExtendBlobsToEpochTransaction} and execution
     * @param {bigint} [params.cost] - precomputed cost (FROST)
     * @param {import('@mysten/sui/transactions').TransactionObjectArgument} [params.walCoin]
     * @param {number} [params.timeout]
     * @param {number} [params.pollIntervalMs]
     * @returns {Promise<number|null>} The new minimum blob end epoch after extension
     * @throws {Error} If the parent vector is not writable
     */
    async extendBlobsToEpoch(targetEndEpoch, params = {}) {
        const ev = this._endlessVector;
        if (!ev.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        const tx = await this.getExtendBlobsToEpochTransaction(targetEndEpoch, params);
        await ev.executeAndWaitForTransaction(tx, params);
        ev.reInitialize();

        return await this.minBlobEndEpoch();
    }

    /**
     * Creates a transaction to push a pre-existing on-chain Blob object into this vector.
     * Use this when you already have a certified Blob object ID.
     *
     * @param {string} blobObjectId - Sui object ID of the certified Blob
     * @param {Transaction} [txToAppendTo=null]
     * @returns {Transaction}
     * @throws {Error} If packageId is not set
     */
    getPushBlobTransaction(blobObjectId, txToAppendTo = null) {
        const ev = this._endlessVector;
        if (!ev._packageId) {
            throw new Error('packageId is required to compose push_back_blob transaction');
        }

        const tx = txToAppendTo ?? new Transaction();

        tx.moveCall({
            target: `${ev._packageId}::endless_walrus::push_back_blob`,
            arguments: [tx.object(ev.id), tx.object(blobObjectId)],
        });

        return tx;
    }

    /**
     * Uploads bytes to Walrus, certifies the blob on-chain, then appends it to this vector.
     *
     * Requires either walrusClient (preferred) or publisherUrl.
     * Uses the parent vector's signAndExecuteTransaction for all on-chain steps.
     *
     * @param {Uint8Array} data - Bytes to store in Walrus
     * @param {Object} [params={}]
     * @param {number} [params.epochs=3] - Walrus storage epochs
     * @param {boolean} [params.deletable=false]
     * @param {number} [params.timeout=30000]
     * @param {number} [params.pollIntervalMs=200]
     * @returns {Promise<{ blobId: string, blobObjectId: string }>}
     * @throws {Error} If parent vector is not writable or no Walrus write transport configured
     */
    async pushBlob(data, params = {}) {
        const ev = this._endlessVector;
        if (!ev.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        const { epochs = 3, deletable = false, timeout = 30000, pollIntervalMs = 200 } = params;

        let blobId, blobObjectId;

        if (this._walrusClient) {
            ({ blobId, blobObjectId } = await this._writeViaWalrusClient(data, { epochs, deletable, timeout, pollIntervalMs }));
        } else if (this._publisherUrl) {
            ({ blobId, blobObjectId } = await this._writeViaPublisherUrl(data, { epochs }));
        } else {
            throw new Error('pushBlob requires walrusClient or publisherUrl');
        }

        const tx = this.getPushBlobTransaction(blobObjectId);
        await ev.executeAndWaitForTransaction(tx, { timeout, pollIntervalMs });

        ev.reInitialize();

        return { blobId, blobObjectId };
    }

    /**
     * @param {Uint8Array} data
     * @param {{ epochs: number, deletable: boolean }} options
     * @returns {Promise<{ blobId: string, blobObjectId: string }>}
     */
    async _writeViaWalrusClient(data, { epochs, deletable, timeout = 30000, pollIntervalMs = 200 }) {
        const ev = this._endlessVector;
        const owner = this._senderAddress || ev.suiClient?.address;

        const flow = this._walrusClient.writeBlobFlow({ blob: data });
        await flow.encode();

        const registerTx = flow.register({ epochs, owner, deletable });
        const registerResult = await ev._signAndExecuteTransaction(registerTx);
        const registerDigest = typeof registerResult === 'string' ? registerResult : registerResult?.digest;
        if (!registerDigest) throw new Error('Walrus register transaction returned no digest');
        console.log('[EndlessVectorWalrus] register digest:', registerDigest);

        await flow.upload({ digest: registerDigest });

        const certifyTx = flow.certify();
        await ev.executeAndWaitForTransaction(certifyTx, { timeout, pollIntervalMs });

        const blob = await flow.getBlob();
        return { blobId: blob.blobId, blobObjectId: blob.blobObjectId };
    }

    /**
     * @param {Uint8Array} data
     * @param {{ epochs: number }} options
     * @returns {Promise<{ blobId: string, blobObjectId: string }>}
     */
    async _writeViaPublisherUrl(data, { epochs }) {
        const url = `${this._publisherUrl}/v1/blobs?epochs=${epochs}`;
        const res = await fetch(url, {
            method: 'PUT',
            body: data,
            headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (!res.ok) throw new Error(`Walrus publisher returned ${res.status}`);

        const json = await res.json();
        const info = json.newlyCreated ?? json.alreadyCertified;
        const blobId = info?.blobObject?.blobId ?? info?.blobId;
        const blobObjectId = info?.blobObject?.id;

        if (!blobId || !blobObjectId) {
            throw new Error('Walrus publisher response missing blobId or blobObjectId');
        }

        return { blobId, blobObjectId };
    }
}
