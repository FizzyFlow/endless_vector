/**
 * Tests for the ensure_length consistency guard.
 *
 * ensure_length is prepended as the first PTB command by getPushTransaction and
 * getPushBlobTransaction when an expectedLength is provided. The whole transaction
 * aborts atomically if the on-chain vector length does not match, preventing:
 *   - duplicate pushes after a timeout-retry (stale client retries with old length)
 *   - concurrent writer races (two clients both read length N and both push)
 *
 * Run: pnpm test:ensure-length
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '../index.js';
import { randomBytesOfLength } from './helpers.js';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 60_000;

let suiMaster;
let walrusClient;
let walrusServer;
let packageId;

beforeAll(async () => {
    ({ suiMaster, walrusClient, walrusServer, packageId } = await setupEndlessVectorLocalnet());
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

async function createEV() {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

function makeEV(id) {
    return new EndlessVector({
        suiClient: suiMaster.client,
        id,
        packageId,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

async function createEVWithWalrus() {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

function makeEVWithWalrus(id) {
    return new EndlessVector({
        suiClient: suiMaster.client,
        id,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

describe('ensure_length guard', () => {
    it('push succeeds when expectedLength matches the current vector length', async () => {
        const ev = await createEV();    // length = 0 on-chain
        await ev.initialize();
        expect(ev.length).toBe(0);

        const tx = ev.getPushTransaction(randomBytesOfLength(1024), null, 0);
        await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });

        await ev.reInitialize();
        await ev.initialize();
        expect(ev.length).toBe(1);
    }, TX_TIMEOUT);

    it('push transaction aborts when expectedLength is stale', async () => {
        const ev = await createEV();
        await ev.push(randomBytesOfLength(1024));   // length → 1
        await ev.initialize();
        expect(ev.length).toBe(1);

        // Build a PTB with expectedLength = 0 (stale — vector is at 1).
        const tx = ev.getPushTransaction(randomBytesOfLength(1024), null, 0);
        await expect(
            suiMaster.signAndExecuteTransaction({
                transaction: tx,
                requestType: 'WaitForLocalExecution',
            })
        ).rejects.toThrow();

        // On-chain length must still be 1 — no double push.
        await ev.reInitialize();
        await ev.initialize();
        expect(ev.length).toBe(1);
    }, TX_TIMEOUT);

    it('stale instance is rejected: concurrent push from second client is blocked', async () => {
        // Two SDK instances pointing at the same vector.
        const ev1 = await createEV();
        const ev2 = makeEV(ev1.id);

        await ev1.initialize();
        await ev2.initialize();
        expect(ev1.length).toBe(0);
        expect(ev2.length).toBe(0);

        // ev1 advances the vector to length 1.
        await ev1.push(randomBytesOfLength(1024));
        await ev1.initialize();
        expect(ev1.length).toBe(1);

        // ev2 is stale (length = 0). Its push() uses this.length = 0 as expectedLength,
        // but the on-chain vector is at 1 → PTB must abort.
        await expect(ev2.push(randomBytesOfLength(1024))).rejects.toThrow();

        // Vector must still be at 1 — ev2's push did not land.
        await ev1.reInitialize();
        await ev1.initialize();
        expect(ev1.length).toBe(1);
    }, TX_TIMEOUT);

    it('normal push() flow is unaffected: sequential pushes all succeed', async () => {
        const ev = await createEV();
        await ev.initialize();

        await ev.push(randomBytesOfLength(1024));
        await ev.push(randomBytesOfLength(2048));
        await ev.push(randomBytesOfLength(512));

        await ev.initialize();
        expect(ev.length).toBe(3);
    }, TX_TIMEOUT);

    it('omitting expectedLength disables the guard (backward-compatible)', async () => {
        // Two pushes from a stale instance without the guard should not abort.
        const ev1 = await createEV();
        const ev2 = makeEV(ev1.id);

        await ev1.initialize();
        await ev2.initialize();

        await ev1.push(randomBytesOfLength(1024));  // length → 1
        await ev1.initialize();

        // ev2 builds PTB without expectedLength — no ensure_length call in the tx.
        const tx = ev2.getPushTransaction(randomBytesOfLength(512)); // no expectedLength arg
        await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });

        await ev1.reInitialize();
        await ev1.initialize();
        expect(ev1.length).toBe(2);
    }, TX_TIMEOUT);
});

describe('ensure_length guard — blob path', () => {
    it('sequential blob pushes all succeed', async () => {
        const ev = await createEVWithWalrus();
        await ev.initialize();

        await ev.push(randomBytesOfLength(200 * 1024));   // → blob, length 0→1
        await ev.push(randomBytesOfLength(150 * 1024));   // → blob, length 1→2
        await ev.push(randomBytesOfLength(130 * 1024));   // → blob, length 2→3

        await ev.initialize();
        expect(ev.length).toBe(3);
    }, TX_TIMEOUT);

    it('stale blob push is rejected by ensure_length', async () => {
        const ev1 = await createEVWithWalrus();
        const ev2 = makeEVWithWalrus(ev1.id);

        await ev1.initialize();
        await ev2.initialize();
        expect(ev1.length).toBe(0);
        expect(ev2.length).toBe(0);

        // ev1 advances the vector to length 1 via a blob push.
        await ev1.push(randomBytesOfLength(200 * 1024));
        await ev1.initialize();
        expect(ev1.length).toBe(1);

        // ev2 is stale (length = 0). Its push() uses this.length = 0 as expectedLength
        // but on-chain length is 1 → PTB aborts.
        await expect(ev2.push(randomBytesOfLength(150 * 1024))).rejects.toThrow();

        // Vector must still be at 1.
        await ev1.reInitialize();
        await ev1.initialize();
        expect(ev1.length).toBe(1);
    }, TX_TIMEOUT);
});
