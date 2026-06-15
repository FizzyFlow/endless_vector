/**
 * Integration test: reading the minimum Walrus blob end epoch on-chain.
 *
 * Exercises `EndlessVectorWalrus.minBlobEndEpoch()`, which calls the
 * `endless_walrus::min_blob_end_epoch` view function via transaction simulation
 * (devInspect) and BCS-decodes the returned `Option<u32>`.
 *
 * Invariants verified:
 *   - A vector with no blobs returns `null` (Move returns `none`).
 *   - With blobs, it returns the smallest storage `end_epoch` across them. A blob
 *     written with `epochs: N` ends at `currentEpoch + N`, so a shorter-lived blob
 *     pulls the minimum down.
 *
 * Run: pnpm test:walrus-blobs-extend  (or pnpm test to run all suites)
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '../index.js';
import { randomBytesOfLength } from './helpers.js';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 120_000;

// > 120 KB so push() / pushBlob() routes the payload to Walrus as a blob item.
const BLOB_SIZE = 200 * 1024;

let suiMaster;
let walrusServer;
let walrusClient;
let packageId;

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, packageId } = await setupEndlessVectorLocalnet());
});

afterAll(async () => {
    await teardownEndlessVectorLocalnet();
});

function makeSignAndExecute() {
    return async (tx) => {
        const result = await suiMaster.signAndExecuteTransaction({ transaction: tx });
        return result.digest;
    };
}

function makeEV() {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

describe('minBlobEndEpoch() via devInspect', () => {
    it('returns null for a vector with no blobs', async () => {
        const ev = await makeEV();

        expect(await ev.walrus.minBlobEndEpoch()).toBe(null);

        // Bytes-only items still have no blobs → still null.
        await ev.push(randomBytesOfLength(1024));
        expect(await ev.walrus.minBlobEndEpoch()).toBe(null);
    }, TX_TIMEOUT);

    it('returns the smallest end epoch across blobs', async () => {
        const ev = await makeEV();

        // Longer-lived blob first (ends at currentEpoch + 5).
        await ev.walrus.pushBlob(randomBytesOfLength(BLOB_SIZE), { epochs: 5 });
        const afterLong = await ev.walrus.minBlobEndEpoch();
        expect(typeof afterLong).toBe('number');
        expect(afterLong).toBeGreaterThan(0);

        // Shorter-lived blob (ends at currentEpoch + 3) pulls the minimum down by 2.
        await ev.walrus.pushBlob(randomBytesOfLength(BLOB_SIZE), { epochs: 3 });
        const afterShort = await ev.walrus.minBlobEndEpoch();
        expect(afterShort).toBe(afterLong - 2);
    }, TX_TIMEOUT);
});

describe('extendBlobsToEpoch() + extendBlobsCostToEpoch()', () => {
    it('extends every blob to a target epoch, paying the exact predicted cost', async () => {
        const ev = await makeEV();

        await ev.walrus.pushBlob(randomBytesOfLength(BLOB_SIZE), { epochs: 3 });
        await ev.walrus.pushBlob(randomBytesOfLength(BLOB_SIZE), { epochs: 4 });

        const before = await ev.walrus.minBlobEndEpoch();
        const target = before + 5;

        // Cost view should report a positive amount for blobs below the target.
        const cost = await ev.walrus.extendBlobsCostToEpoch(target);
        expect(typeof cost).toBe('bigint');
        expect(cost).toBeGreaterThan(0n);

        const newMin = await ev.walrus.extendBlobsToEpoch(target);
        expect(newMin).toBe(target);

        // Once every blob reaches the target, there is nothing left to pay for.
        expect(await ev.walrus.extendBlobsCostToEpoch(target)).toBe(0n);
    }, TX_TIMEOUT);

    it('cost is zero when the target is below the current minimum', async () => {
        const ev = await makeEV();

        await ev.walrus.pushBlob(randomBytesOfLength(BLOB_SIZE), { epochs: 5 });
        const min = await ev.walrus.minBlobEndEpoch();

        expect(await ev.walrus.extendBlobsCostToEpoch(min - 1)).toBe(0n);
    }, TX_TIMEOUT);
});
