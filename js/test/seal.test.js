/**
 * Integration test: layered Seal encryption for EndlessVector.
 *
 *   - Sealed vector: AES-256-GCM encrypts every pushed item; the AES key itself is
 *     Seal-wrapped scoped to the vector's object id (`seal_approve_endless_vector_owner`)
 *     and stored on-chain in `EndlessWalrusVector.seal_encrypted_key`.
 *   - A fresh instance pointing at the same id can read items back by unwrapping the
 *     AES key via Seal (proving ownership in the PTB) and AES-decrypting.
 *   - Concat is refused for sealed vectors (different per-vector AES keys).
 *
 * Run: pnpm test:seal  (or pnpm test to run all suites)
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '../index.js';
import { equalUint8Arrays, randomBytesOfLength } from './helpers.js';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 120_000;

let suiMaster;
let walrusServer;
let walrusClient;
let sealClient;
let packageId;

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, sealClient, packageId } = await setupEndlessVectorLocalnet());
});

afterAll(async () => {
    await teardownEndlessVectorLocalnet();
});

function makeSignAndExecute() {
    return async (tx) => {
        const result = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });
        return result.digest;
    };
}

function makeSealedEV(opts = {}) {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
        sealClient,
        signer: suiMaster._signer ?? suiMaster._keypair,
        ...opts,
    });
}

function makeUnsealedEV() {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

// ─── creation ─────────────────────────────────────────────────────────────────

describe('sealed EndlessVector creation', () => {
    it('attaches a seal_encrypted_key to a newly created vector', async () => {
        const ev = await makeSealedEV();
        expect(ev.id).toMatch(/^0x[0-9a-f]+$/);

        await ev.initialize();
        expect(ev.sealEncryptedKey).toBeInstanceOf(Uint8Array);
        expect(ev.sealEncryptedKey.length).toBeGreaterThan(0);
    }, TX_TIMEOUT);

    it('rejects sealClient + plaintext array round-trip mismatch by encrypting initial items', async () => {
        const initial = [randomBytesOfLength(1024), randomBytesOfLength(2048)];
        const ev = await makeSealedEV({ array: initial });

        await ev.initialize();
        expect(ev.length).toBe(2);
        expect(equalUint8Arrays(await ev.at(0), initial[0])).toBe(true);
        expect(equalUint8Arrays(await ev.at(1), initial[1])).toBe(true);
    }, TX_TIMEOUT);
});

// ─── push + read round-trip ───────────────────────────────────────────────────

describe('sealed push + at round-trip', () => {
    it('pushes a small bytes item and reads it back decrypted', async () => {
        const ev = await makeSealedEV();
        const data = randomBytesOfLength(512);
        await ev.push(data);

        await ev.initialize();
        expect(ev.length).toBe(1);
        const back = await ev.at(0);
        expect(equalUint8Arrays(back, data)).toBe(true);
    }, TX_TIMEOUT);

    it('pushes a 60KB chunked bytes item and reads it back', async () => {
        const ev = await makeSealedEV();
        const data = randomBytesOfLength(60 * 1024);
        await ev.push(data);

        await ev.initialize();
        const back = await ev.at(0);
        expect(equalUint8Arrays(back, data)).toBe(true);
    }, TX_TIMEOUT);

    it('pushes a large walrus blob (>120KB) and reads it back decrypted', async () => {
        const ev = await makeSealedEV();
        const data = randomBytesOfLength(200 * 1024);
        await ev.push(data);

        await ev.initialize();
        expect(ev.length).toBe(1);
        const back = await ev.at(0);
        expect(equalUint8Arrays(back, data)).toBe(true);
    }, TX_TIMEOUT * 2);

    it('stores ciphertext on-chain (not the original plaintext)', async () => {
        const ev = await makeSealedEV();
        const data = randomBytesOfLength(64);
        await ev.push(data);

        // Read the raw bytes path (no seal decryption) and verify it differs from the plaintext.
        const raw = await ev._atRaw(0);
        expect(raw.length).toBe(data.length + 28); // 12B nonce + 16B GCM tag
        expect(equalUint8Arrays(raw, data)).toBe(false);
    }, TX_TIMEOUT);

    it('sanity check: marker IS visible on-chain for an unsealed vector', async () => {
        // Validates that the marker-search approach is sound — i.e. without seal, the
        // plaintext marker DOES appear in the raw on-chain item bytes. Otherwise the
        // "marker not present" assertion in the sealed test would be a false negative.
        const ev = await makeUnsealedEV();

        const marker = new TextEncoder().encode('ENDLESS_VECTOR_PLAIN_MARKER_77');
        const data = new Uint8Array(2048);
        data.set(marker, 100);
        await ev.push(data);

        const rawBytes = await fetchRawItemBytes(ev.id);
        expect(indexOfSubarray(rawBytes, marker)).toBeGreaterThanOrEqual(0);
    }, TX_TIMEOUT);

    it('on-chain object bytes do not contain plaintext marker', async () => {
        const ev = await makeSealedEV();

        // Distinctive plaintext marker — improbable to occur in random ciphertext.
        const marker = new TextEncoder().encode('ENDLESS_VECTOR_SEAL_PLAINTEXT_MARKER_42');
        const data = new Uint8Array(2048);
        data.set(marker, 100);
        await ev.push(data);

        const rawBytes = await fetchRawItemBytes(ev.id);
        // Plaintext marker must not appear in the on-chain item bytes — they're ciphertext.
        expect(indexOfSubarray(rawBytes, marker)).toBe(-1);
    }, TX_TIMEOUT);

    it('walrus-stored bytes (fetched directly from aggregator) are ciphertext, not plaintext', async () => {
        const ev = await makeSealedEV();

        const marker = new TextEncoder().encode('WALRUS_SEAL_PLAINTEXT_MARKER_99');
        const data = randomBytesOfLength(200 * 1024);
        data.set(marker, 12345);
        await ev.push(data);

        // Find the blob_id for the just-pushed walrus blob from the raw on-chain object.
        await ev.initialize();
        const { object } = await suiMaster.client.getObject({
            objectId: ev.id,
            include: { json: true },
        });
        const items = object?.json?.items ?? [];
        // The first (and only) item should be a blob; pull its blob_id.
        const blobItem = items[0];
        const blobIdDecimal =
            blobItem?.item?.fields?.blob_id
            ?? blobItem?.blob?.blob_id
            ?? blobItem?.blob_id;
        expect(blobIdDecimal).toBeDefined();

        // gRPC returns blob_id as a decimal u256 string; aggregator expects base64url.
        const { default: EndlessVectorWalrus } = await import('../EndlessVectorWalrus.js');
        const blobIdB64 = EndlessVectorWalrus._encodeBlobId(String(blobIdDecimal));

        const res = await fetch(`${walrusServer.url}/v1/blobs/${blobIdB64}`);
        expect(res.status).toBe(200);
        const stored = new Uint8Array(await res.arrayBuffer());

        // Walrus stores ciphertext: marker must not appear as a contiguous run.
        expect(indexOfSubarray(stored, marker)).toBe(-1);
        // And the stored bytes must differ in length from the plaintext (28B AES-GCM overhead).
        expect(stored.length).toBe(data.length + 28);
    }, TX_TIMEOUT * 2);
});

/** Fetch the first inline item's bytes (base64-decoded) from the on-chain vector object. */
async function fetchRawItemBytes(vectorId) {
    const { object } = await suiMaster.client.getObject({
        objectId: vectorId,
        include: { json: true },
    });
    const items = object?.json?.items ?? [];
    const b64 = items[0]?.bytes ?? '';
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Linear-scan substring search over Uint8Arrays. Returns -1 if `needle` is not present in `hay`. */
function indexOfSubarray(hay, needle) {
    if (needle.length === 0) return 0;
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

// ─── fresh instance round-trip ───────────────────────────────────────────────

describe('sealed re-reading by id', () => {
    it('fresh EndlessVector instance can unwrap the AES key via Seal and read back items', async () => {
        const original = await makeSealedEV();
        const a = randomBytesOfLength(1024);
        const b = randomBytesOfLength(4 * 1024);
        await original.push(a);
        await original.push(b);

        // Fresh instance — no in-memory AES key cache; must unwrap via Seal.
        const fresh = new EndlessVector({
            suiClient: suiMaster.client,
            id: original.id,
            packageId,
            walrusClient,
            aggregatorUrl: walrusServer?.url,
            senderAddress: suiMaster.address,
            signAndExecuteTransaction: makeSignAndExecute(),
            sealClient,
            signer: suiMaster._signer ?? suiMaster._keypair,
        });

        await fresh.initialize();
        expect(fresh.sealEncryptedKey).toBeInstanceOf(Uint8Array);
        expect(fresh.length).toBe(2);

        expect(equalUint8Arrays(await fresh.at(0), a)).toBe(true);
        expect(equalUint8Arrays(await fresh.at(1), b)).toBe(true);
    }, TX_TIMEOUT * 2);
});

// ─── concat refused ──────────────────────────────────────────────────────────

describe('unsealed vector with sealClient passed', () => {
    it('works normally when sealClient is provided but vector is not encrypted', async () => {
        const ev = await makeUnsealedEV();
        const data = randomBytesOfLength(1024);
        await ev.push(data);

        // Open a fresh instance with sealClient — should still read plaintext fine.
        const fresh = new EndlessVector({
            suiClient: suiMaster.client,
            id: ev.id,
            packageId,
            walrusClient,
            aggregatorUrl: walrusServer?.url,
            senderAddress: suiMaster.address,
            signAndExecuteTransaction: makeSignAndExecute(),
            sealClient,
            signer: suiMaster._signer ?? suiMaster._keypair,
        });

        await fresh.initialize();
        expect(fresh.sealEncryptedKey).toBeNull();
        expect(await fresh.isEncrypted()).toBe(false);
        expect(fresh.length).toBe(1);
        expect(equalUint8Arrays(await fresh.at(0), data)).toBe(true);
    }, TX_TIMEOUT);

    it('isEncrypted returns true for sealed vectors and false for unsealed', async () => {
        const sealed = await makeSealedEV();
        expect(await sealed.isEncrypted()).toBe(true);

        const unsealed = await makeUnsealedEV();
        expect(await unsealed.isEncrypted()).toBe(false);
    }, TX_TIMEOUT);
});

// ─── concat refused ──────────────────────────────────────────────────────────

describe('sealed concat is refused', () => {
    it('throws at the SDK layer when source is sealed', async () => {
        const dst = await makeUnsealedEV();
        const src = await makeSealedEV();
        await src.push(new Uint8Array([1, 2, 3]));

        // Refusal can come from the SDK pre-check (when dst is sealed) or from the
        // Move assertion (when only src is sealed). Either way the tx fails.
        await expect(dst.concat(src)).rejects.toThrow();
    }, TX_TIMEOUT);

    it('throws at the SDK layer when destination is sealed', async () => {
        const dst = await makeSealedEV();
        const src = await makeUnsealedEV();
        await src.push(new Uint8Array([1, 2, 3]));

        await dst.initialize();
        await expect(dst.concat(src)).rejects.toThrow(/sealed/i);
    }, TX_TIMEOUT);
});
