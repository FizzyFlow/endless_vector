import { Transaction } from '@mysten/sui/transactions';

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
        if (!/^\d+$/.test(String(value))) return value;
        let n = BigInt(value);
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            bytes[i] = Number(n & 0xffn);
            n >>= 8n;
        }
        const b64 = Buffer.from(bytes).toString('base64');
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
     * @param {number} [params.pollIntervalMs=1000]
     * @returns {Promise<{ blobId: string, blobObjectId: string }>}
     * @throws {Error} If parent vector is not writable or no Walrus write transport configured
     */
    async pushBlob(data, params = {}) {
        const ev = this._endlessVector;
        if (!ev.isWritable) {
            throw new Error('EndlessVector is not writable, packageId and signAndExecuteTransaction are required');
        }

        const { epochs = 3, deletable = false, timeout = 30000, pollIntervalMs = 1000 } = params;

        let blobId, blobObjectId;

        if (this._walrusClient) {
            ({ blobId, blobObjectId } = await this._writeViaWalrusClient(data, { epochs, deletable }));
        } else if (this._publisherUrl) {
            ({ blobId, blobObjectId } = await this._writeViaPublisherUrl(data, { epochs }));
        } else {
            throw new Error('pushBlob requires walrusClient or publisherUrl');
        }

        const tx = this.getPushBlobTransaction(blobObjectId);
        const digest = await ev._signAndExecuteTransaction(tx);

        const txResult = await ev.suiClient.waitForTransaction({
            digest,
            include: { effects: true },
            timeout,
            pollInterval: pollIntervalMs,
        });
        const txData = txResult.Transaction ?? txResult.FailedTransaction;
        if (!txData?.status?.success) {
            throw new Error('push_back_blob transaction failed');
        }

        ev.reInitialize();

        return { blobId, blobObjectId };
    }

    /**
     * @param {Uint8Array} data
     * @param {{ epochs: number, deletable: boolean }} options
     * @returns {Promise<{ blobId: string, blobObjectId: string }>}
     */
    async _writeViaWalrusClient(data, { epochs, deletable }) {
        const ev = this._endlessVector;
        const owner = this._senderAddress || ev.suiClient?.address;

        const flow = this._walrusClient.writeBlobFlow({ blob: data });
        await flow.encode();

        const registerTx = flow.register({ epochs, owner, deletable });
        const registerDigest = await ev._signAndExecuteTransaction(registerTx);
        if (!registerDigest) throw new Error('Walrus register transaction returned no digest');

        await flow.upload({ digest: registerDigest });

        const certifyTx = flow.certify();
        await ev._signAndExecuteTransaction(certifyTx);

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
