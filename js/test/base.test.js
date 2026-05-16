/**
 * Integration test for EndlessVector SDK methods (create, push, at, concat)
 * using the seal_walrus_localnet infrastructure and suidouble v2 / gRPC client.
 *
 * Run: pnpm test:base  (or pnpm test to run all suites)
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '../index.js';
import { equalUint8Arrays, randomBytesOfLength } from './helpers.js';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 60_000;

let suiMaster;
let walrusServer;
let walrusClient;
let packageId;

// ─── setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, packageId } = await setupEndlessVectorLocalnet());
    console.log('package id:', packageId);
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

async function createEV(array = null) {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
        ...(array ? { array } : {}),
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

// ─── tests ────────────────────────────────────────────────────────────────────

describe('deployment', () => {
    it('publishes the combined package', () => {
        expect(packageId).toMatch(/^0x[0-9a-f]+$/);
    });
});

describe('raw create transaction', () => {
    it('creates EndlessVector with 120KB payload via raw tx and reads it back', async () => {
        const arr = randomBytesOfLength(120 * 1024);

        const tx = new suiMaster.Transaction();
        const vectorTxInput = await EndlessVector.getCreateTransactionAndReturnVectorInput(
            { packageId },
            arr,
            tx,
        );
        tx.transferObjects([vectorTxInput], tx.pure.address(suiMaster.address));

        const signAndExecute = makeSignAndExecute();
        const digest = await signAndExecute(tx);

        const txResult = await suiMaster.client.waitForTransaction({
            digest,
            include: { effects: true, objectTypes: true },
        });
        const txData = txResult.Transaction ?? txResult.FailedTransaction;
        expect(txData?.status?.success).toBe(true);

        const objectTypes = txData.objectTypes ?? {};
        const created = txData.effects?.changedObjects?.find(
            c => c.idOperation === 'Created' &&
                 (objectTypes[c.objectId] ?? '').includes('EndlessWalrusVector'),
        );
        expect(created).toBeDefined();

        const loadBack = makeEV(created.objectId);
        await loadBack.initialize();

        expect(loadBack.length).toBe(1);
        const back = await loadBack.at(0);
        expect(equalUint8Arrays(back, arr)).toBe(true);
    }, TX_TIMEOUT);
});

describe('create with array of chunks', () => {
    it('creates EndlessVector with 3 pre-loaded chunks and reads each back', async () => {
        const data = [
            randomBytesOfLength(1 * 1024),
            randomBytesOfLength(2 * 1024),
            randomBytesOfLength(3 * 1024),
        ];

        const ev = await createEV(data);

        expect(equalUint8Arrays(await ev.at(0), data[0])).toBe(true);
        expect(equalUint8Arrays(await ev.at(1), data[1])).toBe(true);
        expect(equalUint8Arrays(await ev.at(2), data[2])).toBe(true);

        expect(ev.length).toBe(3);
        expect(ev.binaryLength).toBe(6 * 1024);
    }, TX_TIMEOUT);
});

describe('push and at', () => {
    let ev;

    it('creates empty EndlessVector', async () => {
        ev = await createEV();
        expect(ev).toBeDefined();
        expect(ev.id).toMatch(/^0x[0-9a-f]+$/);
        expect(ev.isWritable).toBe(true);
    }, TX_TIMEOUT);

    it('pushes small Uint8Array and reads it back', async () => {
        await ev.push(new Uint8Array([1, 2, 3]));
        const back = await ev.at(0);
        expect(equalUint8Arrays(back, new Uint8Array([1, 2, 3]))).toBe(true);
        await ev.initialize();
        expect(ev.length).toBe(1);
        expect(ev.binaryLength).toBe(3);
    }, TX_TIMEOUT);

    it('pushes 30KB array', async () => {
        const large = randomBytesOfLength(30 * 1024);
        await ev.push(large);
        const back = await ev.at(1);
        expect(equalUint8Arrays(back, large)).toBe(true);
        expect(ev.length).toBe(2);
        expect(ev.binaryLength).toBe(3 + 30 * 1024);
    }, TX_TIMEOUT);

    it('pushes 120KB array', async () => {
        const large = randomBytesOfLength(120 * 1024);
        await ev.push(large);
        const back = await ev.at(2);
        expect(equalUint8Arrays(back, large)).toBe(true);
        expect(ev.length).toBe(3);
        expect(ev.binaryLength).toBe(3 + 30 * 1024 + 120 * 1024);
    }, TX_TIMEOUT);

    it('rejects arrays larger than 120KB when no walrus is configured', async () => {
        const evNoWalrus = new EndlessVector({
            suiClient: suiMaster.client,
            id: ev.id,
            packageId,
            signAndExecuteTransaction: makeSignAndExecute(),
        });
        const tooLarge = randomBytesOfLength(120 * 1024 + 1);
        await expect(evNoWalrus.push(tooLarge)).rejects.toThrow();
    });

    let walrusLargeData;

    it('auto-routes arrays > 120 KB to walrus when configured', async () => {
        walrusLargeData = randomBytesOfLength(200 * 1024);
        const ok = await ev.push(walrusLargeData);
        expect(ok).toBe(true);

        await ev.initialize();
        expect(ev.length).toBe(4);
    }, TX_TIMEOUT);

    it('reads back the walrus-stored item via at()', async () => {
        const back = await ev.at(3);
        expect(equalUint8Arrays(back, walrusLargeData)).toBe(true);
    }, TX_TIMEOUT);

    it('pushes 3 × 40KB in a single transaction block', async () => {
        const size = 40 * 1024;
        const a1 = randomBytesOfLength(size);
        const a2 = randomBytesOfLength(size);
        const a3 = randomBytesOfLength(size);

        const tx = new suiMaster.Transaction();
        ev.getPushTransaction(a1, tx);
        ev.getPushTransaction(a2, tx);
        ev.getPushTransaction(a3, tx);

        await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });

        await ev.reInitialize();
        await ev.initialize();

        expect(equalUint8Arrays(await ev.at(4), a1)).toBe(true);
        expect(equalUint8Arrays(await ev.at(5), a2)).toBe(true);
        expect(equalUint8Arrays(await ev.at(6), a3)).toBe(true);
        expect(ev.length).toBe(7);
        expect(ev.binaryLength).toBe(3 + 30 * 1024 + 120 * 1024 + 200 * 1024 + 3 * size);
    }, TX_TIMEOUT);
});

describe('concat', () => {
    it('appends a second vector into the first and verifies data', async () => {
        const ev1 = await createEV();
        const ev2 = await createEV();

        const d1 = new Uint8Array([10, 20, 30]);
        const d2 = new Uint8Array([40, 50, 60]);
        await ev2.push(d1);
        await ev2.push(d2);

        await ev2.initialize();
        expect(ev2.length).toBe(2);

        await ev1.initialize();
        const len1Before = ev1.length;
        const binLen1Before = ev1.binaryLength;

        await ev1.concat(ev2);
        await ev1.initialize();

        expect(ev1.length).toBe(len1Before + 2);
        expect(ev1.binaryLength).toBe(binLen1Before + 6);

        expect(equalUint8Arrays(await ev1.at(len1Before), d1)).toBe(true);
        expect(equalUint8Arrays(await ev1.at(len1Before + 1), d2)).toBe(true);
    }, TX_TIMEOUT);

    it('appends array of vectors via concat([...])', async () => {
        const ev3 = await createEV();
        const ev4 = await createEV();
        const ev5 = await createEV();

        const d3 = new Uint8Array([100, 101, 102]);
        const d4 = new Uint8Array([200, 201, 202]);
        const d5 = new Uint8Array([44, 55, 66]);

        await ev3.push(d3);
        await ev4.push(d4);
        await ev5.push(d5);

        await ev3.initialize();
        await ev4.initialize();
        await ev5.initialize();

        const len3 = ev3.length;
        const bin3 = ev3.binaryLength;

        await ev3.concat([ev4, ev5]);
        await ev3.initialize();

        expect(ev3.length).toBe(len3 + 2);
        expect(ev3.binaryLength).toBe(bin3 + 6);

        expect(equalUint8Arrays(await ev3.at(0), d3)).toBe(true);
        expect(equalUint8Arrays(await ev3.at(1), d4)).toBe(true);
        expect(equalUint8Arrays(await ev3.at(2), d5)).toBe(true);
    }, TX_TIMEOUT);
});

describe('parallel creation and append', () => {
    it('creates 6 vectors in parallel and concatenates them', async () => {
        const vectorCount = 6;

        const splitTx = new suiMaster.Transaction();
        for (let i = 0; i < vectorCount; i++) {
            let coin = splitTx.splitCoins(splitTx.gas, [splitTx.pure.u64(BigInt(1000000000))]);
            splitTx.transferObjects([coin], splitTx.pure.address(suiMaster.address));
        }
        await suiMaster.signAndExecuteTransaction({
            transaction: splitTx,
            requestType: 'WaitForLocalExecution',
        });

        const testData = Array.from({ length: vectorCount }, () => randomBytesOfLength(1024));

        const gasCoinsResponse = await suiMaster.client.listCoins({
            owner: suiMaster.address,
            coinType: '0x2::sui::SUI',
        });
        const gasCoinInputs = gasCoinsResponse.objects.map((c) => ({
            objectId: c.objectId,
            digest: c.digest,
            version: c.version,
        }));

        const createPromises = [];
        for (let i = 0; i < vectorCount; i++) {
            createPromises.push(
                EndlessVector.create({
                    suiClient: suiMaster.client,
                    packageId,
                    array: testData[i] ?? null,
                    gasCoin: gasCoinInputs[i],
                    signAndExecuteTransaction: makeSignAndExecute(),
                })
            );
        }

        const vectors = await Promise.all(createPromises);

        expect(vectors).toHaveLength(vectorCount);
        vectors.forEach((v, i) => {
            expect(v.id).toMatch(/^0x[0-9a-f]+$/);
            console.log(`vector ${i}: ${v.id}`);
        });

        const main = vectors[0];
        await main.concat(vectors.slice(1));
        await main.initialize();

        expect(main.length).toBe(vectorCount);

        for (let i = 0; i < vectorCount; i++) {
            const back = await main.at(i);
            expect(equalUint8Arrays(back, testData[i])).toBe(true);
        }
    }, 300_000);
});

describe('archive', () => {
    it('archives history and data remains readable', async () => {
        const data = [
            randomBytesOfLength(1 * 1024),
            randomBytesOfLength(2 * 1024),
            randomBytesOfLength(3 * 1024),
        ];

        const ev = await createEV(data);
        await ev.initialize();

        const lengthBefore = ev.length;
        const binLengthBefore = ev.binaryLength;
        expect(lengthBefore).toBe(3);

        const extra = randomBytesOfLength(120 * 1024);
        await ev.push(extra);

        await ev.archive();
        await ev.initialize();

        expect(ev.length).toBe(4);
        expect(ev.binaryLength).toBe(binLengthBefore + 120 * 1024);
        expect(ev.archiveItemsCount).toBe(1);
        expect(ev.archivedAtLength).toBe(4);
        expect(ev.historyItemsCount).toBe(0);
        expect(ev.burnedArchiveCount).toBe(0);

        expect(equalUint8Arrays(await ev.at(0), data[0])).toBe(true);
        expect(equalUint8Arrays(await ev.at(1), data[1])).toBe(true);
        expect(equalUint8Arrays(await ev.at(2), data[2])).toBe(true);
        expect(equalUint8Arrays(await ev.at(3), extra)).toBe(true);

        const afterArchive = randomBytesOfLength(4 * 1024);
        await ev.push(afterArchive);
        await ev.initialize();

        expect(ev.length).toBe(5);
        expect(equalUint8Arrays(await ev.at(4), afterArchive)).toBe(true);
        expect(equalUint8Arrays(await ev.at(0), data[0])).toBe(true);
        expect(equalUint8Arrays(await ev.at(3), extra)).toBe(true);

        await ev.burnArchive();
        await ev.initialize();

        expect(ev.burnedArchiveCount).toBe(1);
        expect(ev.archivedFromLength).toBe(4);
        expect(ev.length).toBe(5);

        expect(equalUint8Arrays(await ev.at(4), afterArchive)).toBe(true);

        await expect(ev.at(0)).rejects.toThrow();
        await expect(ev.at(1)).rejects.toThrow();
        await expect(ev.at(2)).rejects.toThrow();
        await expect(ev.at(3)).rejects.toThrow();
    }, TX_TIMEOUT);

    it('multiple archive/burn cycles accumulate archivedFromLength correctly', async () => {
        const ev = await createEV();

        const batch1 = randomBytesOfLength(120 * 1024);
        await ev.push(batch1);
        await ev.archive();
        await ev.initialize();
        expect(ev.archiveItemsCount).toBe(1);
        expect(ev.archivedAtLength).toBe(1);

        const batch2 = randomBytesOfLength(120 * 1024);
        await ev.push(batch2);
        await ev.archive();
        await ev.initialize();
        expect(ev.archiveItemsCount).toBe(2);
        expect(ev.archivedAtLength).toBe(2);

        expect(equalUint8Arrays(await ev.at(0), batch1)).toBe(true);
        expect(equalUint8Arrays(await ev.at(1), batch2)).toBe(true);

        await ev.burnArchive();
        await ev.initialize();
        expect(ev.burnedArchiveCount).toBe(1);
        expect(ev.archivedFromLength).toBe(1);

        await expect(ev.at(0)).rejects.toThrow();
        expect(equalUint8Arrays(await ev.at(1), batch2)).toBe(true);

        await ev.burnArchive();
        await ev.initialize();
        expect(ev.burnedArchiveCount).toBe(2);
        expect(ev.archivedFromLength).toBe(2);

        await expect(ev.at(1)).rejects.toThrow();
    }, TX_TIMEOUT);

    it('re-reading vector by ID after archive and burn reflects correct state', async () => {
        const ev = await createEV();
        const item = randomBytesOfLength(120 * 1024);
        await ev.push(item);
        await ev.archive();
        await ev.burnArchive();

        const fresh = makeEV(ev.id);
        await fresh.initialize();

        expect(fresh.burnedArchiveCount).toBe(1);
        expect(fresh.archivedFromLength).toBe(1);
        expect(fresh.length).toBe(1);
        await expect(fresh.at(0)).rejects.toThrow();
    }, TX_TIMEOUT);

    it('concat rejects a source vector that has archived items', async () => {
        const src = await createEV();
        const dst = await createEV();

        const item = randomBytesOfLength(120 * 1024);
        await src.push(item);
        await src.archive();
        await src.initialize();
        expect(src.archiveItemsCount).toBeGreaterThan(0);

        await expect(dst.concat(src)).rejects.toThrow();
    }, TX_TIMEOUT);
});
