/**
 * Integration test: create certified Walrus blobs and push them into an
 * EndlessWalrusVector via raw Move calls (no SDK).
 *
 * Run: pnpm test:walrus-blobs  (or pnpm test to run all suites)
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { setupEndlessVectorLocalnet, teardownEndlessVectorLocalnet } from './fixture.js';

const TX_TIMEOUT = 60_000;

let suiMaster;
let walrusState;
let packageId;
/** @type {string} on-chain EndlessWalrusVector object id */
let vectorId;

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getVectorState() {
    const obj = await suiMaster.getObject(vectorId);
    await obj.fetchFields();
    const fields = obj.fields ?? {};
    return {
        length: parseInt(fields.length ?? 0),
        binaryLength: parseInt(fields.binary_length ?? 0),
    };
}

// ─── setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
    ({ suiMaster, walrusState, packageId } = await setupEndlessVectorLocalnet());
});

afterAll(async () => {
    await teardownEndlessVectorLocalnet();
});

// ─── deployment sanity ────────────────────────────────────────────────────────

describe('deployment', () => {
    it('publishes the combined package', () => {
        expect(packageId).toMatch(/^0x[0-9a-f]+$/);
    });

    it('bootstraps the walrus committee (epoch == 1)', async () => {
        const epoch = await walrusState.systemEpoch();
        expect(epoch).toBe(1);
    });
});

// ─── create EndlessWalrusVector ───────────────────────────────────────────────

describe('EndlessWalrusVector creation', () => {
    it('creates an empty EndlessWalrusVector on-chain', async () => {
        const tx = new Transaction();
        const vectorObj = tx.moveCall({
            target: `${packageId}::endless_walrus::empty`,
            arguments: [],
        });
        tx.transferObjects([vectorObj], tx.pure.address(suiMaster.address));

        const result = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
            include: { effects: true, objectTypes: true },
        });
        await result.waitForTransaction({ include: { effects: true, objectTypes: true } });

        const createdObj = result.created.find(
            o => o.type && o.type.includes('EndlessWalrusVector')
        );
        expect(createdObj).toBeDefined();
        vectorId = createdObj.address;
        console.log('vectorId:', vectorId);
    }, TX_TIMEOUT);
});

// ─── push certified blobs ─────────────────────────────────────────────────────

describe('push walrus blobs into EndlessWalrusVector', () => {
    it('creates 3 certified blobs of different sizes and pushes each', async () => {
        const sizes = [512, 4 * 1024, 64 * 1024];

        for (const size of sizes) {
            const blob = await walrusState.makeTestBlob({ size, certify: true });
            expect(blob.id).toMatch(/^0x[0-9a-f]+$/);
            expect(await blob.isCertified()).toBe(true);

            const tx = new Transaction();
            tx.moveCall({
                target: `${packageId}::endless_walrus::push_back_blob`,
                arguments: [tx.object(vectorId), tx.object(blob.id)],
            });
            const result = await suiMaster.signAndExecuteTransaction({
                transaction: tx,
                requestType: 'WaitForLocalExecution',
            });
            expect(result.digest).toBeTruthy();
            console.log(`pushed blob size=${size} id=${blob.id}`);
        }
    }, TX_TIMEOUT);

    it('vector has length 3 and non-zero binaryLength after 3 blob pushes', async () => {
        const state = await getVectorState();
        expect(state.length).toBe(3);
        expect(state.binaryLength).toBeGreaterThan(0);
        console.log('binaryLength after 3 blobs:', state.binaryLength);
    });

    it('pushes 2 more blobs in a single transaction', async () => {
        const blob1 = await walrusState.makeTestBlob({ size: 1024, certify: true });
        const blob2 = await walrusState.makeTestBlob({ size: 2048, certify: true });

        const tx = new Transaction();
        tx.moveCall({
            target: `${packageId}::endless_walrus::push_back_blob`,
            arguments: [tx.object(vectorId), tx.object(blob1.id)],
        });
        tx.moveCall({
            target: `${packageId}::endless_walrus::push_back_blob`,
            arguments: [tx.object(vectorId), tx.object(blob2.id)],
        });

        const result = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });
        expect(result.digest).toBeTruthy();

        const state = await getVectorState();
        expect(state.length).toBe(5);
    }, TX_TIMEOUT);
});

// ─── mix: raw bytes + blob in the same vector ─────────────────────────────────

describe('mixed items: raw bytes and blobs', () => {
    it('pushes raw bytes and a certified blob into the same vector', async () => {
        const rawBytes = [0xde, 0xad, 0xbe, 0xef];

        const txBytes = new Transaction();
        txBytes.moveCall({
            target: `${packageId}::endless_walrus::push_back_bytes`,
            arguments: [
                txBytes.object(vectorId),
                txBytes.pure.vector('u8', rawBytes),
            ],
        });
        const r1 = await suiMaster.signAndExecuteTransaction({
            transaction: txBytes,
            requestType: 'WaitForLocalExecution',
        });
        expect(r1.digest).toBeTruthy();

        const blob = await walrusState.makeTestBlob({ size: 8192, certify: true });
        const txBlob = new Transaction();
        txBlob.moveCall({
            target: `${packageId}::endless_walrus::push_back_blob`,
            arguments: [txBlob.object(vectorId), txBlob.object(blob.id)],
        });
        const r2 = await suiMaster.signAndExecuteTransaction({
            transaction: txBlob,
            requestType: 'WaitForLocalExecution',
        });
        expect(r2.digest).toBeTruthy();

        // 5 blobs + 1 raw bytes + 1 blob = 7
        const state = await getVectorState();
        expect(state.length).toBe(7);

        console.log('final vector length:', state.length);
        console.log('final binaryLength:', state.binaryLength);
    }, TX_TIMEOUT);
});
