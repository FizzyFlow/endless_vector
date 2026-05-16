/**
 * Integration test: exercises ev.push() with both small and large payloads.
 * Small arrays (≤ 120 KB) go through a regular Move tx; larger ones are
 * transparently routed to Walrus via walrus.pushBlob().
 *
 * Run: pnpm test:walrus-blobs-sdk  (or pnpm test to run all suites)
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '../index.js';
import { randomBytesOfLength } from './helpers.js';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 60_000;

let suiMaster;
let walrusServer;
let walrusClient;
let packageId;

/** @type {EndlessVector} */
let ev;

// ─── setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, packageId } = await setupEndlessVectorLocalnet());
});

afterAll(async () => {
    await teardownEndlessVectorLocalnet();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeSignAndExecute() {
    return async (tx) => {
        const result = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });
        return result.digest;
    };
}

async function makeEV({ usePublisherUrl = false } = {}) {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient: usePublisherUrl ? undefined : walrusClient,
        publisherUrl: usePublisherUrl ? walrusServer.url : undefined,
        aggregatorUrl: walrusServer.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

// ─── deployment ───────────────────────────────────────────────────────────────

describe('deployment', () => {
    it('publishes the combined package', () => {
        expect(packageId).toMatch(/^0x[0-9a-f]+$/);
    });

    it('bootstraps the walrus committee (epoch == 1)', async () => {
        const { walrusState } = await setupEndlessVectorLocalnet();
        const epoch = await walrusState.systemEpoch();
        expect(epoch).toBe(1);
    });
});

// ─── create ───────────────────────────────────────────────────────────────────

describe('EndlessVector creation', () => {
    it('creates an empty EndlessVector via SDK', async () => {
        ev = await makeEV();
        expect(ev.id).toMatch(/^0x[0-9a-f]+$/);
        expect(ev.isWritable).toBe(true);
        expect(ev.walrus).toBeDefined();
    }, TX_TIMEOUT);
});

// ─── push via ev.push() ───────────────────────────────────────────────────────

describe('push items via ev.push()', () => {
    it('pushes small items (≤ 120 KB) via regular tx', async () => {
        const sizes = [512, 4 * 1024, 64 * 1024];

        for (const size of sizes) {
            const data = randomBytesOfLength(size);
            const ok = await ev.push(data);
            expect(ok).toBe(true);
            console.log(`pushed ${size}B via tx`);
        }

        await ev.initialize();
        expect(ev.length).toBe(3);
        expect(ev.binaryLength).toBeGreaterThan(0);
    }, TX_TIMEOUT);

    it('pushes a large item (> 120 KB) via walrus fallback', async () => {
        const data = randomBytesOfLength(200 * 1024);
        const ok = await ev.push(data);
        expect(ok).toBe(true);
        console.log(`pushed 200 KB via walrus fallback`);

        await ev.initialize();
        expect(ev.length).toBe(4);
    }, TX_TIMEOUT);

    it('pushes 2 more small items sequentially', async () => {
        await ev.push(randomBytesOfLength(1024));
        await ev.push(randomBytesOfLength(2048));

        await ev.initialize();
        expect(ev.length).toBe(6);
    }, TX_TIMEOUT);
});

// ─── round-trip reads ─────────────────────────────────────────────────────────

describe('round-trip reads', () => {
    /** @type {EndlessVector} */
    let evRoundTrip;

    it('creates a fresh vector for round-trip tests (publisherUrl path)', async () => {
        evRoundTrip = await makeEV({ usePublisherUrl: true });
        expect(evRoundTrip.id).toMatch(/^0x[0-9a-f]+$/);
    }, TX_TIMEOUT);

    it('reads back small item pushed via tx', async () => {
        const data = randomBytesOfLength(512);
        await evRoundTrip.push(data);

        await evRoundTrip.initialize();
        const back = await evRoundTrip.at(evRoundTrip.length - 1);
        expect(back).toEqual(data);
    }, TX_TIMEOUT);

    it('reads back a large item pushed via walrus fallback (publisherUrl)', async () => {
        const data = randomBytesOfLength(200 * 1024);
        await evRoundTrip.push(data);

        await evRoundTrip.initialize();
        const back = await evRoundTrip.at(evRoundTrip.length - 1);
        expect(back).toEqual(data);
    }, TX_TIMEOUT);
});
