'use strict'

import t, { end } from 'tap';
import { SuiMaster, SuiLocalTestValidator, SuiObject } from 'suidouble';
import { fileURLToPath } from 'url';
import path from 'path';
import { equalUint8Arrays, formatBytes, randomBytesOfLength } from './helpers.js';

import { EndlessVector } from '../index.js';
// import { get } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { test } = t;

let suiLocalTestValidator = null;

/** @type {?SuiMaster} */
let suiMaster = null;
let signAndExecuteTransaction = null;

let contract = null;

/** @type {?SuiObject} */
let endlessVectorRaw = null;     // SuiObject instance
/** @type {?EndlessVector} */
let endlessVector = null;        // EndlessVector instance

test('spawn local test node', async t => {
    suiLocalTestValidator = await SuiLocalTestValidator.launch({ testFallbackEnabled: true, debug: true, });
    t.ok(suiLocalTestValidator.active);
    // SuiLocalTestValidator runs as signle instance. So you can't start it twice with static method
    const suiLocalTestValidatorCopy = await SuiLocalTestValidator.launch();
    t.equal(suiLocalTestValidator, suiLocalTestValidatorCopy);
});

test('init suiMaster and connect it to local test validator', async t => {
    suiMaster = new SuiMaster({client: 'local', as: 'noname_tester', debug: true});
    await suiMaster.initialize();
    t.ok(suiMaster.address); // there should be some address
    t.ok(`${suiMaster.address}`.indexOf('0x') === 0); // adress is string starting with '0x'

    signAndExecuteTransaction = async (tx) => {
        // function accepting Transaction and returning signed and submitted transaction digest
        const results = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
        });
        return results.digest;
    }
});

test('request sui from faucet', async t => {
    const balanceBefore = await suiMaster.getBalance();
    await suiMaster.requestSuiFromFaucet();
    await suiMaster.requestSuiFromFaucet();
    await suiMaster.requestSuiFromFaucet();
    await suiMaster.requestSuiFromFaucet();
    await suiMaster.requestSuiFromFaucet();
    await suiMaster.requestSuiFromFaucet();
    const balanceAfter = await suiMaster.getBalance();
    t.ok(balanceAfter > balanceBefore);
});

test('attach a local package', async t => {
    contract = suiMaster.addPackage({
        path: path.join(__dirname, '../../move'),
    });
    await contract.build({ withUnpublishedDependencies: true, });
    await contract.publish();
});


test('test raw create transaction', async t => {
    const arr = randomBytesOfLength(120 * 1024); // 100KB
    
    const tx = new suiMaster.Transaction();
    const vectorTxInput = await EndlessVector.getCreateTransactionAndReturnVectorInput({
        packageId: contract.id,
    }, arr, tx);
    tx.transferObjects([vectorTxInput], tx.pure.address(suiMaster.address));
    
    t.ok(tx);
    let digest = null;
    try {
        digest = await signAndExecuteTransaction(tx);
        t.ok(digest);
    } catch (e) {
        console.error('Error preparing transaction:', e);
    }

    const transactionBlockResponse = await suiMaster.client.waitForTransaction({
        digest: digest,
        options: { showObjectChanges: true, },
    }); 

    // Find the created EndlessVector object
    const objectChanges = transactionBlockResponse.objectChanges || [];
    const createdVector = objectChanges.find(
        change => change.type === 'created' &&
                    change.objectType &&
                    change.objectType.includes('endless_vector::EndlessVector')
    );

    const createdVectorId = createdVector ? createdVector.objectId : null;
    t.ok(createdVectorId, 'Created EndlessVector object should have an ID');

    const loadBack = new EndlessVector({
        suiClient: suiMaster.client,
        id: createdVectorId,
    });
    await loadBack.initialize();

    t.ok(loadBack.length === 1, `Loaded vector should have length 1, got ${loadBack.length}`);
    const getBack = await loadBack.at(0);
    t.ok(equalUint8Arrays(getBack, arr), 'Data retrieved from loaded vector should match original data');
});


test('make a test EndlessVector with few chunks in a single tx', async t => {
    const data = [
        randomBytesOfLength(1 * 1024),
        randomBytesOfLength(2 * 1024),
        randomBytesOfLength(3 * 1024),
    ];

    const testEndlessVector = await EndlessVector.create({
        array: data,
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });

    const getBack0 = await testEndlessVector.at(0);
    const getBack1 = await testEndlessVector.at(1);
    const getBack2 = await testEndlessVector.at(2);

    t.ok(equalUint8Arrays(getBack0, data[0]));
    t.ok(equalUint8Arrays(getBack1, data[1]));
    t.ok(equalUint8Arrays(getBack2, data[2]));

    t.ok(testEndlessVector.length === 3);
    t.ok(testEndlessVector.binaryLength === 6 * 1024);
});

test('make a test EndlessVector and push single Uint8Array to it', async t => {
    endlessVector = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });

    t.ok(endlessVector);
    t.ok(endlessVector.id);
    t.ok(endlessVector.isWritable); // we provided packageId and signAndExecuteTransaction

    await endlessVector.push(new Uint8Array([1,2,3]));

    const getBack = await endlessVector.at(0);
    t.ok(equalUint8Arrays(getBack, new Uint8Array([1,2,3])));

    await endlessVector.initialize(); // endlessVector.at(0) calles initialize() internally, but we call it again to keep code clear

    t.ok(endlessVector.length === 1);
    t.ok(endlessVector.binaryLength === 3);
});

test('push Uint8Array larger than max_pure_argument_size to it', async t => {
    const largeArray = randomBytesOfLength(30 * 1024); // 30KB
    await endlessVector.push(largeArray);

    const getBack = await endlessVector.at(1);
    t.ok(equalUint8Arrays(getBack, largeArray));
    t.ok(getBack.length === 30*1024);

    t.ok(endlessVector.length === 2);
    t.ok(endlessVector.binaryLength === 3 + 30*1024);
});

test('push Uint8Array larger than max_pure_argument_size to it', async t => {
    const largeArray = randomBytesOfLength(120 * 1024); // 120KB
    await endlessVector.push(largeArray);

    const getBack = await endlessVector.at(2);
    t.ok(equalUint8Arrays(getBack, largeArray));
    t.ok(getBack.length === 120*1024);

    t.ok(endlessVector.length === 3);
    t.ok(endlessVector.binaryLength === 3 + 30*1024 + 120*1024);
});


test('throws an Error is trying to push too large Uint8Array ( split it on the higher level )', async t => {
    const tooLargeSize = 120 * 1024 + 1; // 120KB + 1 byte
    const largeArray = randomBytesOfLength(tooLargeSize);
    await t.rejects(endlessVector.push(largeArray), Error, 'expected an Error to be thrown');
});

test('push few Uint8Array in a single transaction block', async t => {
    const singleItemSize = 40 * 1024; 
    const largeArray1 = randomBytesOfLength(singleItemSize);
    const largeArray2 = randomBytesOfLength(singleItemSize);
    const largeArray3 = randomBytesOfLength(singleItemSize);
    const tx = new suiMaster.Transaction();
    await endlessVector.getPushTransaction(largeArray1, tx);
    await endlessVector.getPushTransaction(largeArray2, tx);
    await endlessVector.getPushTransaction(largeArray3, tx);

    await suiMaster.signAndExecuteTransaction({
            transaction: tx,
            requestType: 'WaitForLocalExecution',
        });

    await endlessVector.reInitialize(); // force re-initialization to load new data
    const getBack1 = await endlessVector.at(3);
    const getBack2 = await endlessVector.at(4);
    const getBack3 = await endlessVector.at(5);

    t.ok(equalUint8Arrays(getBack1, largeArray1));
    t.ok(getBack1.length === singleItemSize);

    t.ok(equalUint8Arrays(getBack2, largeArray2));
    t.ok(getBack2.length === singleItemSize);

    t.ok(equalUint8Arrays(getBack3, largeArray3));
    t.ok(getBack3.length === singleItemSize);

    console.log(endlessVector.length);
    console.log(endlessVector.binaryLength);
    t.ok(endlessVector.length === 6);
    t.ok(endlessVector.binaryLength === 3 + 30*1024 + 120*1024 + 3*singleItemSize);
});


test('test concat functionality', async t => {
    // Create a second EndlessVector
    const endlessVector2 = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });
    t.ok(endlessVector2);
    t.ok(endlessVector2.id);

    // Push some data to the second vector
    const data1 = new Uint8Array([10, 20, 30]);
    const data2 = new Uint8Array([40, 50, 60]);
    await endlessVector2.push(data1);
    await endlessVector2.push(data2);

    await endlessVector2.initialize();
    t.ok(endlessVector2.length === 2);
    t.ok(endlessVector2.binaryLength === 6);

    // Get lengths before concat
    await endlessVector.initialize();
    const v1LengthBefore = endlessVector.length;
    const v1BinaryLengthBefore = endlessVector.binaryLength;
    const v2Length = endlessVector2.length;
    const v2BinaryLength = endlessVector2.binaryLength;

    console.log('v1 before concat:', { length: v1LengthBefore, binaryLength: v1BinaryLengthBefore });
    console.log('v2 before concat:', { length: v2Length, binaryLength: v2BinaryLength });

    // Concat the second vector into the first
    // Both of these work - passing ID string or EndlessVector instance:
    // await endlessVector.concat(endlessVector2.id);
    await endlessVector.concat(endlessVector2);  // Passing EndlessVector instance

    // Verify the first vector now contains both vectors' data
    await endlessVector.initialize();
    console.log('v1 after concat:', { length: endlessVector.length, binaryLength: endlessVector.binaryLength });

    t.ok(endlessVector.length === v1LengthBefore + v2Length, 'length should be sum of both vectors');
    t.ok(endlessVector.binaryLength === v1BinaryLengthBefore + v2BinaryLength, 'binary length should be sum of both vectors');

    // Verify we can access the concatenated data
    const getBackFromV2_1 = await endlessVector.at(v1LengthBefore);
    const getBackFromV2_2 = await endlessVector.at(v1LengthBefore + 1);

    t.ok(equalUint8Arrays(getBackFromV2_1, data1), 'first item from v2 should be accessible in v1');
    t.ok(equalUint8Arrays(getBackFromV2_2, data2), 'second item from v2 should be accessible in v1');
});


test('test concat with array (append)', async t => {
    // Create three new EndlessVectors
    const endlessVector3 = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });
    const endlessVector4 = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });
    const endlessVector5 = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });

    // Push data to all vectors
    const data3 = new Uint8Array([100, 101, 102]);
    const data4 = new Uint8Array([200, 201, 202]);
    const data5 = new Uint8Array([300, 301, 302]);

    await endlessVector3.push(data3);
    await endlessVector4.push(data4);
    await endlessVector5.push(data5);

    await endlessVector3.initialize();
    await endlessVector4.initialize();
    await endlessVector5.initialize();

    const v3Length = endlessVector3.length;
    const v3BinaryLength = endlessVector3.binaryLength;
    const v4Length = endlessVector4.length;
    const v4BinaryLength = endlessVector4.binaryLength;
    const v5Length = endlessVector5.length;
    const v5BinaryLength = endlessVector5.binaryLength;

    console.log('Before append:', { v3Length, v4Length, v5Length });

    // Concat with array (append) - passing array of EndlessVector instances
    await endlessVector3.concat([endlessVector4, endlessVector5]);

    await endlessVector3.initialize();
    console.log('After append:', { length: endlessVector3.length, binaryLength: endlessVector3.binaryLength });

    t.ok(endlessVector3.length === v3Length + v4Length + v5Length, 'length should be sum of all vectors');
    t.ok(endlessVector3.binaryLength === v3BinaryLength + v4BinaryLength + v5BinaryLength, 'binary length should be sum of all vectors');

    // Verify data integrity
    const retrieved3 = await endlessVector3.at(0);
    const retrieved4 = await endlessVector3.at(1);
    const retrieved5 = await endlessVector3.at(2);

    t.ok(equalUint8Arrays(retrieved3, data3), 'v3 data should match');
    t.ok(equalUint8Arrays(retrieved4, data4), 'v4 data should match');
    t.ok(equalUint8Arrays(retrieved5, data5), 'v5 data should match');
});


test('test concat large EndlessVectors', async t => {
    // Create three new EndlessVectors
    const endlessVectorMain = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });
    const endlessVectorSecond = await EndlessVector.create({
        suiClient: suiMaster.client, // instance of Sui SDK SuiClient
        packageId: contract.id, // provide packageId and signAndExecuteTransaction to make EndlessVector writable
        signAndExecuteTransaction: signAndExecuteTransaction,
    });

    const data = [
    ];

    for (let i = 0; i < 33; i++) {
        let toMain = randomBytesOfLength(0 + Math.floor(1024 + 50 * 1024 * Math.random())); // 1KB - 50KB
        if (Math.random() < 0.2) {
            toMain = new Uint8Array([]); // 20% chance to push empty array
        }

        data.push(toMain);
    }

    for (const item of data) {
        await endlessVectorMain.push(item);
    }

    for (let i = 0; i < 33; i++) {
        let toSecond = randomBytesOfLength(0 + Math.floor(1024 + 50 * 1024 * Math.random())); // 1KB - 50KB
        if (Math.random() < 0.2) {
            toSecond = new Uint8Array([]); // 20% chance to push empty array
        }
        
        await endlessVectorSecond.push(toSecond);
        data.push(toSecond);
    }

    await endlessVectorMain.concat(endlessVectorSecond);

    await endlessVectorMain.initialize();

    t.ok(endlessVectorMain.length === data.length, 'length should be sum of both vectors');

    // Verify data integrity
    for (let i = 0; i < data.length; i++) {
        const retrieved = await endlessVectorMain.at(i);
        t.ok(equalUint8Arrays(retrieved, data[i]), `data at index ${i} should match`);
    }
});


test('test parallel creation, push, and append of 6 vectors', async t => {
    const vectorCount = 6;

    // Split gas into at least N coins to use them in parallel transactions
    const splitTx = new suiMaster.Transaction();
    for (let i = 0; i < vectorCount; i++) {
        let coin = splitTx.splitCoins(splitTx.gas, [splitTx.pure.u64(BigInt(1000000000))]);
        splitTx.transferObjects([coin], splitTx.pure.address(suiMaster.address));
    }
    await suiMaster.signAndExecuteTransaction({
        transaction: splitTx,
        requestType: 'WaitForLocalExecution',
    });

    // Get gas coins and prepare inputs for tx.setGasPayment(...);
    const gasCoins = await suiMaster.client.getCoins({
        owner: suiMaster.address,
        coinType: '0x2::sui::SUI',
    });
    const gasCoinInputs = gasCoins.data.map((c) => { 
			return {
				objectId: c.coinObjectId,
				digest: c.digest,
				version: c.version,
			};
		});

    t.ok(gasCoinInputs.length >= vectorCount, `should have at least ${vectorCount} gas coins for parallel vector creation.`);

    // Prepare test data for each vector
    const testData = [];
    for (let i = 0; i < vectorCount; i++) {
        testData.push(randomBytesOfLength(1024));
    }

    // Create N EndlessVectors in parallel using static create method
    const createPromises = [];
    for (let i = 0; i < vectorCount; i++) {
        createPromises.push(
            EndlessVector.create({
                suiClient: suiMaster.client,
                packageId: contract.id,
                array: testData[i] ? testData[i] : null,
                gasCoin: gasCoinInputs[i],
                signAndExecuteTransaction: async (tx) => {
                    console.log(`Creating vector ${i}...`);
                    try {
                        const results = await suiMaster.signAndExecuteTransaction({
                            transaction: tx,
                        });
                        return results.digest;
                    } catch (e) {
                        console.error(`Error creating vector ${i}:`, e);
                    }
                },
            })
        );
    }

    const vectors = await Promise.all(createPromises);
    vectors.forEach((v, i) => {
        console.log(`Created vector ${i} with id: ${v.id}`);
    });

    t.ok(vectors.length === vectorCount, `should have created ${vectorCount} vectors`);

    const ids = {};
    vectors.forEach((v, i) => {
        t.ok(v.id, `vector ${i} should have an id`);
        t.ok(!ids[v.id], `vector id ${v.id} should be unique`);
        ids[v.id] = i;
    });

    const mainVector = vectors[0];
    // append other vectors to the first one
    const vectorsToAppend = vectors.slice(1);
    await mainVector.concat(vectorsToAppend);

    // Verify the data after concatenation
    await mainVector.initialize();

    const expectedLength = vectorCount;
    t.ok(mainVector.length === expectedLength, `mainVector should have ${expectedLength} items, got ${mainVector.length}`);

    console.log(`Verifying ${expectedLength} items in concatenated vector...`);

    // Verify each item matches the original testData
    for (let vectorIdx = 0; vectorIdx < vectorCount; vectorIdx++) {
        const expected = testData[vectorIdx];
        const retrieved = await mainVector.at(vectorIdx);

        t.ok(
            equalUint8Arrays(retrieved, expected),
            `Item ${vectorIdx} (vector ${vectorIdx}, item ${vectorIdx}) should match`
        );
    }
});

test('stops local test node', async t => {
    await SuiLocalTestValidator.stop();
});