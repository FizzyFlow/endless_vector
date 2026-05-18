/**
 * Integration test: walrus blob items through history and archive lifecycle.
 *
 * Key invariants from the Move contract:
 *   - Blob items have an on-object storage_volume of 32 bytes (only the reference
 *     is stored; the payload lives in Walrus).
 *   - Clamp triggers when (new_item_storage + current_storage) > SAFE_INNER_SIZE (128 KB).
 *   - A single blob (32 bytes) + one 120 KB bytes item = ~122 KB < 128 KB → no clamp yet.
 *   - Adding a second small bytes item (~9 KB) tips the total over 128 KB → clamp fires.
 *   - fillToHistory() encapsulates this two-push pattern.
 *   - The FILL_SMALL item that triggers clamp goes into current (not history), because
 *     clamp(ev, some(new_item)) routes the triggering item into the fresh current segment.
 *
 * Run: pnpm test:walrus-blobs-history  (or pnpm test to run all suites)
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '../index.js';
import { equalUint8Arrays, randomBytesOfLength } from './helpers.js';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 120_000;

// Clamp triggers when (new_item_storage + current_storage) > SAFE_INNER_SIZE (128 KB).
// A single blob costs only 32 bytes of on-object storage, so it never triggers clamp
// alone. We use a two-push fill: first a 120 KB bytes item (max tx path, 122 880 bytes),
// then a 9 KB bytes item — combined with the blob that brings total to ~132 KB > 128 KB.
const FILL_LARGE = 120 * 1024;   // first fill push (via tx, stays under 120 KB limit)
const FILL_SMALL =   9 * 1024;   // second fill push (tips over 128 KB threshold)

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
        const result = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            // requestType: 'WaitForLocalExecution',
        });
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

/**
 * Push two bytes items via tx to tip storage over 128 KB and trigger clamp.
 * Items currently in `ev` go to history; FILL_SMALL lands in the new current segment.
 * Net effect on length: +2 items (FILL_LARGE in history, FILL_SMALL in current).
 */
async function fillToHistory(ev) {
    await ev.push(randomBytesOfLength(FILL_LARGE));  // storage grows but stays < 128 KB
    await ev.push(randomBytesOfLength(FILL_SMALL));  // this one triggers clamp
}

// ─── blobs in history ─────────────────────────────────────────────────────────

describe('blob pushed into history via vector<u8> fill', () => {
    it('blob at index 0 is readable after being pushed into history', async () => {
        const ev = await makeEV();

        const blobData = randomBytesOfLength(200 * 1024);
        await ev.push(blobData);      // blob → current (32 bytes on-object storage)
        await fillToHistory(ev);      // blob + FILL_LARGE → history[0], FILL_SMALL → current

        await ev.initialize();
        // blob (index 0) + FILL_LARGE (index 1) in history; FILL_SMALL (index 2) in current
        expect(ev.length).toBe(3);
        expect(ev.historyItemsCount).toBe(1);

        const back = await ev.at(0);
        expect(equalUint8Arrays(back, blobData)).toBe(true);
    }, TX_TIMEOUT);

    it('multiple blobs in history, all readable', async () => {
        const ev = await makeEV();

        // Must be > 120 KB (> 122 880 bytes) so push() routes them to walrus as blob
        // items; walrus blobs cost only 32 bytes of on-object storage each.
        const blobs = [
            randomBytesOfLength(130 * 1024),
            randomBytesOfLength(150 * 1024),
            randomBytesOfLength(200 * 1024),
        ];

        // push 3 blobs (total on-object storage = 3 × 32 = 96 bytes, well under 128 KB)
        for (const b of blobs) await ev.push(b);

        // fillToHistory: FILL_LARGE goes in alongside blobs, FILL_SMALL triggers clamp
        // → all 4 (blobs + FILL_LARGE) go to history[0]; FILL_SMALL lands in current
        await fillToHistory(ev);

        await ev.initialize();
        expect(ev.length).toBe(5);  // 3 blobs + FILL_LARGE in history + FILL_SMALL in current
        expect(ev.historyItemsCount).toBe(1);

        for (let i = 0; i < blobs.length; i++) {
            const back = await ev.at(i);
            expect(equalUint8Arrays(back, blobs[i])).toBe(true);
        }
    }, TX_TIMEOUT * 2);

    it('blobs and bytes items coexist in the same history segment', async () => {
        const ev = await makeEV();

        const bytesItem = randomBytesOfLength(1024);
        const blobItem  = randomBytesOfLength(200 * 1024);

        await ev.push(bytesItem);    // bytes → current (1 KB storage)
        await ev.push(blobItem);     // blob  → current (32 bytes storage)
        await fillToHistory(ev);     // bytesItem + blobItem + FILL_LARGE → history; FILL_SMALL → current

        await ev.initialize();
        expect(ev.length).toBe(4);
        expect(ev.historyItemsCount).toBe(1);

        expect(equalUint8Arrays(await ev.at(0), bytesItem)).toBe(true);
        expect(equalUint8Arrays(await ev.at(1), blobItem)).toBe(true);
    }, TX_TIMEOUT * 2);
});

// ─── multiple history segments ────────────────────────────────────────────────

describe('blobs across multiple history segments', () => {
    it('blob readable from any history segment after two fill cycles', async () => {
        const ev = await makeEV();

        const blob1 = randomBytesOfLength(130 * 1024);
        const blob2 = randomBytesOfLength(150 * 1024);

        // segment 0: blob1 + FILL_LARGE → history[0]; FILL_SMALL → current
        await ev.push(blob1);
        await fillToHistory(ev);

        // segment 1: blob2 + prev-FILL_SMALL + FILL_LARGE → history[1]; FILL_SMALL → current
        await ev.push(blob2);
        await fillToHistory(ev);

        await ev.initialize();
        // exact segment count varies (leftover FILL_SMALL from cycle 1 may add an extra
        // clamp in cycle 2), but there must be at least 2 history segments
        expect(ev.historyItemsCount).toBeGreaterThanOrEqual(2);

        expect(equalUint8Arrays(await ev.at(0), blob1)).toBe(true);
        // blob2 lands at index 3 (blob1, FILL_LARGE, FILL_SMALL from cycle 1)
        expect(equalUint8Arrays(await ev.at(3), blob2)).toBe(true);
    }, TX_TIMEOUT);
});

// ─── blobs in archive ─────────────────────────────────────────────────────────

describe('blob archived and readable', () => {
    it('blob in history is readable after archive()', async () => {
        const ev = await makeEV();

        const blobData = randomBytesOfLength(200 * 1024);
        await ev.push(blobData);
        await fillToHistory(ev);  // blob + FILL_LARGE → history; FILL_SMALL → current

        await ev.archive();       // history → archive; clamp sweeps current → history first
        await ev.initialize();

        expect(ev.archiveItemsCount).toBe(1);
        expect(ev.historyItemsCount).toBe(0);

        const back = await ev.at(0);
        expect(equalUint8Arrays(back, blobData)).toBe(true);
    }, TX_TIMEOUT);

    it('items pushed after archive() are readable alongside archived blob', async () => {
        const ev = await makeEV();

        const blobData = randomBytesOfLength(200 * 1024);
        await ev.push(blobData);
        await fillToHistory(ev);

        await ev.archive();

        const afterArchive = randomBytesOfLength(4 * 1024);
        await ev.push(afterArchive);

        await ev.initialize();

        expect(equalUint8Arrays(await ev.at(0), blobData)).toBe(true);
        expect(equalUint8Arrays(await ev.at(ev.length - 1), afterArchive)).toBe(true);
    }, TX_TIMEOUT * 2);
});

// ─── archive + burn ───────────────────────────────────────────────────────────

describe('blob archive burn lifecycle', () => {
    it('burned archived blob throws on at(), remaining items are readable', async () => {
        const ev = await makeEV();

        const blobData  = randomBytesOfLength(200 * 1024);
        const afterData = randomBytesOfLength(4 * 1024);

        await ev.push(blobData);
        await fillToHistory(ev);   // blob + FILL_LARGE → history; FILL_SMALL → current
        await ev.archive();        // archive() clamps first → everything into archive
        await ev.push(afterData);

        await ev.burnArchive();
        await ev.initialize();

        expect(ev.burnedArchiveCount).toBe(1);
        expect(ev.length).toBeGreaterThan(0);

        // all archived items throw
        const burnedCount = ev.archivedFromLength;
        for (let i = 0; i < burnedCount; i++) {
            await expect(ev.at(i)).rejects.toThrow();
        }

        // item pushed after archive is still readable
        expect(equalUint8Arrays(await ev.at(ev.length - 1), afterData)).toBe(true);
    }, TX_TIMEOUT);

    it('multiple archive/burn cycles with blobs accumulate archivedFromLength', async () => {
        const ev = await makeEV();

        const blob1 = randomBytesOfLength(130 * 1024);
        const blob2 = randomBytesOfLength(130 * 1024);

        // cycle 1
        await ev.push(blob1);
        await fillToHistory(ev);
        await ev.archive();
        await ev.burnArchive();
        await ev.initialize();

        const burned1 = ev.archivedFromLength;
        expect(ev.burnedArchiveCount).toBe(1);
        expect(burned1).toBeGreaterThan(0);

        for (let i = 0; i < burned1; i++) {
            await expect(ev.at(i)).rejects.toThrow();
        }

        // cycle 2
        await ev.push(blob2);
        await fillToHistory(ev);
        await ev.archive();
        await ev.burnArchive();
        await ev.initialize();

        const burned2 = ev.archivedFromLength;
        expect(ev.burnedArchiveCount).toBe(2);
        expect(burned2).toBeGreaterThan(burned1);

        for (let i = burned1; i < burned2; i++) {
            await expect(ev.at(i)).rejects.toThrow();
        }
    }, TX_TIMEOUT);
});

// ─── re-read by ID ────────────────────────────────────────────────────────────

describe('re-reading vector by ID with blob in history', () => {
    it('fresh instance resolves blob from history correctly', async () => {
        const ev = await makeEV();

        const blobData = randomBytesOfLength(200 * 1024);
        await ev.push(blobData);
        await fillToHistory(ev);

        const fresh = new EndlessVector({
            suiClient: suiMaster.client,
            id: ev.id,
            packageId,
            walrusClient,
            aggregatorUrl: walrusServer?.url,
            senderAddress: suiMaster.address,
            signAndExecuteTransaction: makeSignAndExecute(),
        });
        await fresh.initialize();

        expect(fresh.historyItemsCount).toBe(1);
        const back = await fresh.at(0);
        expect(equalUint8Arrays(back, blobData)).toBe(true);
    }, TX_TIMEOUT * 3);
});
