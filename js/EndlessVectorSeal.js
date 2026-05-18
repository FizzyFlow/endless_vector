import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { SessionKey } from '@mysten/seal';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

/**
 * @typedef {import('@mysten/seal').SealClient} SealClient
 * @typedef {import('@mysten/seal').SessionKey} SessionKey_T
 * @typedef {import('./EndlessVector.js').default} EndlessVector
 */

const AES_KEY_BYTES   = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES   = 16;
const DEFAULT_TTL_MIN = 5;

/**
 * Seal-layered encryption companion for EndlessVector.
 * Attached as `endlessVector.seal` on every EndlessVector instance; only "enabled"
 * when a sealClient is supplied at construction time.
 *
 * When enabled, the parent EndlessVector encrypts every pushed item with a per-vector
 * AES-256-GCM key and decrypts on read. The AES key itself is Seal-encrypted scoped
 * to the vector's object id and stored on-chain as `EndlessWalrusVector.seal_encrypted_key`.
 * Access policy: `seal_approve_endless_vector_owner` (only the vector owner can decrypt
 * the AES key — anyone else gets ciphertext only).
 *
 * AES payload layout: `nonce(12B) || ciphertext || tag(16B)` (28B overhead per item).
 */
export default class EndlessVectorSeal {
    /**
     * @param {Object} params
     * @param {EndlessVector} params.endlessVector - parent EndlessVector
     * @param {SealClient} [params.sealClient]
     * @param {SessionKey_T} [params.sessionKey] - optional pre-built SessionKey
     * @param {any} [params.signer] - keypair/signer to mint a SessionKey when needed
     * @param {number} [params.sealTtlMin=5] - SessionKey ttl in minutes
     */
    constructor(params = {}) {
        /** @type {EndlessVector} */
        this._endlessVector = params.endlessVector || null;
        /** @type {?SealClient} */
        this._sealClient = params.sealClient || null;
        /** @type {?SessionKey_T} */
        this._sessionKey = params.sessionKey || null;
        /** @type {?any} */
        this._signer = params.signer || null;
        /** @type {number} */
        this._ttlMin = params.sealTtlMin || DEFAULT_TTL_MIN;

        /** @type {?Uint8Array} - cached plaintext AES key (after key unwrap) */
        this._aesKey = null;
    }

    /** True iff a sealClient was supplied. Callers gate behavior on this. */
    get isEnabled() {
        return !!this._sealClient;
    }

    /** Generate a fresh AES-256 key — used at `create()` time when sealing a new vector. */
    static generateAesKey() {
        return randomBytes(AES_KEY_BYTES);
    }

    /** Cache a plaintext AES key (e.g. immediately after `create()` so the first push needn't unwrap). */
    setAesKey(key) {
        if (!(key instanceof Uint8Array) || key.length !== AES_KEY_BYTES) {
            throw new Error(`seal: key must be a ${AES_KEY_BYTES}-byte Uint8Array`);
        }
        this._aesKey = key;
    }

    /**
     * Seal-encrypt the AES key scoped to the vector's object id.
     * Caller is responsible for storing the returned bytes on-chain via
     * `set_seal_encrypted_key` on the vector.
     *
     * @param {Uint8Array} aesKey
     * @returns {Promise<Uint8Array>} the Seal-encrypted (wrapped) key
     */
    async wrapAesKey(aesKey) {
        this._assertEnabled();
        const ev = this._endlessVector;
        if (!ev._packageId) throw new Error('seal.wrapAesKey requires packageId on the vector');
        if (!ev.id) throw new Error('seal.wrapAesKey requires the vector id (call after create())');

        const idHex = EndlessVectorSeal._objectIdToHex(ev.id);
        const { encryptedObject } = await this._sealClient.encrypt({
            threshold: 1,
            packageId: ev._packageId,
            id: idHex,
            data: aesKey,
        });
        return new Uint8Array(encryptedObject);
    }

    /** Encrypt a single item before push. */
    async encryptItem(plaintext) {
        this._assertEnabled();
        const key = await this._ensureAesKey();
        const nonce = randomBytes(AES_NONCE_BYTES);
        const ct = gcm(key, nonce).encrypt(plaintext);
        const out = new Uint8Array(AES_NONCE_BYTES + ct.length);
        out.set(nonce, 0);
        out.set(ct, AES_NONCE_BYTES);
        return out;
    }

    /** Decrypt a single item after read. */
    async decryptItem(payload) {
        this._assertEnabled();
        if (payload.length < AES_NONCE_BYTES + AES_TAG_BYTES) {
            throw new Error(`seal.decryptItem: payload too short (${payload.length})`);
        }
        const key = await this._ensureAesKey();
        const nonce = payload.subarray(0, AES_NONCE_BYTES);
        const ct = payload.subarray(AES_NONCE_BYTES);
        return gcm(key, nonce).decrypt(ct);
    }

    /**
     * Resolve the plaintext AES key. If it's already cached, return it; otherwise fetch
     * the wrapped key from the vector's on-chain state, build a PTB proving ownership via
     * `seal_approve_endless_vector_owner`, and run `sealClient.decrypt`.
     */
    async _ensureAesKey() {
        if (this._aesKey) return this._aesKey;

        const ev = this._endlessVector;
        await ev.initialize();
        const wrapped = ev.sealEncryptedKey;
        if (!wrapped) throw new Error('seal: vector has no seal_encrypted_key on-chain');

        const idHex = EndlessVectorSeal._objectIdToHex(ev.id);
        const tx = new Transaction();
        tx.moveCall({
            target: `${ev._packageId}::endless_walrus::seal_approve_endless_vector_owner`,
            arguments: [
                tx.pure.vector('u8', Array.from(fromHex(idHex))),
                tx.object(ev.id),
            ],
        });

        const senderAddress = this._senderAddress();
        if (!senderAddress) throw new Error('seal: senderAddress is required to build the seal_approve PTB');
        tx.setSender(senderAddress);
        const txBytes = await tx.build({ client: ev.suiClient });

        const sessionKey = await this._ensureSessionKey();
        const aesKey = await this._sealClient.decrypt({
            data: wrapped,
            sessionKey,
            txBytes,
        });
        this._aesKey = new Uint8Array(aesKey);
        return this._aesKey;
    }

    async _ensureSessionKey() {
        if (this._sessionKey && !this._sessionKey.isExpired?.()) return this._sessionKey;
        if (!this._signer) throw new Error('seal: signer or sessionKey is required to mint a SessionKey');

        const ev = this._endlessVector;
        const senderAddress = this._senderAddress();
        if (!senderAddress) throw new Error('seal: senderAddress is required to mint a SessionKey');

        this._sessionKey = await SessionKey.create({
            address: senderAddress,
            packageId: ev._packageId,
            ttlMin: this._ttlMin,
            signer: this._signer,
            suiClient: ev.suiClient,
        });
        return this._sessionKey;
    }

    _senderAddress() {
        // Prefer an explicit walrus.senderAddress (already plumbed for blob writes);
        // fall back to the suiClient address if present.
        return this._endlessVector?.walrus?._senderAddress
            ?? this._endlessVector?.suiClient?.address
            ?? null;
    }

    _assertEnabled() {
        if (!this.isEnabled) throw new Error('seal: sealClient not configured on this EndlessVector');
    }

    static _objectIdToHex(objectId) {
        return String(objectId).replace(/^0x/, '').padStart(64, '0');
    }
}
