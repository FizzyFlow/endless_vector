import path from 'path';
import { SuiMaster } from 'suidouble';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

import fs, { writeFileSync } from 'fs';


export const getPublishedAt = (chain, pathToMoveLOCK) => {
    const data = fs.readFileSync(path.join(__dirname, pathToMoveLOCK), 'utf8');
    const lines = data.split("\n");
    let blockStarted = false;
    for (const line of lines) {
        if (line.includes('[env.'+chain+']')) {
            blockStarted = true;
        }
        if (blockStarted && line.includes('latest-published-id')) {
            const id = line.split('=')[1].split('"')[1].trim();
            if (id.startsWith('0x')) {
                console.log('latest-published-id in ', pathToMoveLOCK, ' = ', id);
                return id;
            } else {
                throw new Error('can not get published at from', pathToMoveLOCK);
            }
        }
    }
} 


const run = async()=>{
    // RUST_LOG="off,sui_node=info" sui start --with-faucet --force-regenesis
    const privateKey = await fs.promises.readFile(path.join(__dirname, './.privatekey'), 'utf-8');

    if (!privateKey) {
        console.error('Please create a file .privatekey with your private key');
        return;
    }

    const id = await getPublishedAt('mainnet', '../move/Move.lock');
    console.error(id);
    console.log(path.join(__dirname, '../move'));

    const suiMaster = new SuiMaster({client: 'mainnet', privateKey: privateKey, debug: true});
    await suiMaster.initialize();
    try {
        await suiMaster.requestSuiFromFaucet();
    } catch (e) {
        // ok, if you have mainnet sui in wallet
        console.error(e);
    }
    
    console.log(suiMaster.address);

    const pk = suiMaster.addPackage({
        id: id,
        path: path.join(__dirname, '../move'),
    });
    await pk.isOnChain();

    await pk.build({ env: 'mainnet' });

    await pk.upgrade();

    console.log('should be upgraded. Do not forget to update in config and Move.lock');
    console.log('upgraded packageId', pk.address);
};

run();