import path from 'path';
import { SuiMaster } from 'suidouble';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

const run = async()=>{
    // RUST_LOG="off,sui_node=info" sui start --with-faucet --force-regenesis
    const privateKey = await fs.promises.readFile(path.join(__dirname, './.privatekey'), 'utf-8');

    if (!privateKey) {
        console.error('Please create a file .privatekey with your private key');
        return;
    }

    const suiMaster = new SuiMaster({client: 'mainnet', privateKey: privateKey, debug: true});
    await suiMaster.initialize();
    
    console.log(suiMaster.address);

    const pk = suiMaster.addPackage({
        path: path.join(__dirname, '../move'),
    });
    await pk.build({ env: 'mainnet' });
    await pk.publish();

    console.log('deployed as', pk.id);
    console.log('add info to Move.lock as per https://docs.sui.io/concepts/sui-move-concepts/packages/automated-address-management');
};

run();