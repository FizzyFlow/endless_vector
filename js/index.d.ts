import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction, TransactionResult, TransactionObjectArgument } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';

/**
 * Custom function to sign and execute transactions
 */
export type CustomSignAndExecuteTransactionFunction = (tx: Transaction) => Promise<string>;

/**
 * Configuration parameters for creating an EndlessVector instance
 */
export interface EndlessVectorConstructorParams {
    /** Sui gRPC client instance for blockchain interactions */
    suiClient?: SuiGrpcClient;
    /** ID or address of the EndlessVector on the Sui blockchain */
    id?: string;
    /** Adds write capability if provided, ID of the Move package containing the EndlessVector module or 'mainnet', 'testnet' to use known IDs */
    packageId?: string | null;
    /** Adds write capability if provided, function should accept Sui transaction, sign and submit it to the blockchain and return its digest */
    signAndExecuteTransaction?: CustomSignAndExecuteTransactionFunction | null;
    /** Walrus SDK client for blob reads and writes */
    walrusClient?: any | null;
    /** Walrus publisher HTTP URL for blob uploads (fallback if no walrusClient) */
    publisherUrl?: string | null;
    /** Walrus aggregator HTTP URL for blob reads (fallback if no walrusClient) */
    aggregatorUrl?: string | null;
    /** Sui address of the transaction sender, required for Walrus blob writes */
    senderAddress?: string | null;
    /** SealClient for Seal encryption/decryption */
    sealClient?: any | null;
    /** Pre-built SessionKey for Seal operations */
    sessionKey?: any | null;
    /** Keypair or signer to mint a SessionKey when needed */
    signer?: Signer | null;
    /** SessionKey TTL in minutes (default: 5) */
    sealTtlMin?: number;
}

/**
 * Configuration parameters for creating a new EndlessVector via static create method
 */
export interface EndlessVectorCreateParams {
    /** Sui gRPC client instance for blockchain interactions */
    suiClient: SuiGrpcClient;
    /** ID of the Move package containing the EndlessVector module */
    packageId: string;
    /** Function to sign and execute transactions */
    signAndExecuteTransaction: CustomSignAndExecuteTransactionFunction;
    /** Optional Uint8Array or array of Uint8Arrays to initialize the vector with */
    array?: Uint8Array | Uint8Array[] | null;
    /** Optional gas coin object reference {objectId: string, digest: string, version: string} to use for transaction payment */
    gasCoin?: { objectId: string; digest: string; version: string } | null;
    /** Optional transaction parameters */
    options?: {
        /** Transaction confirmation timeout in ms, default 30000 */
        timeout?: number;
        /** Poll interval in ms, default 1000 */
        pollIntervalMs?: number;
    };
    /** Walrus SDK client for blob reads and writes */
    walrusClient?: any | null;
    /** Walrus aggregator HTTP URL for blob reads (fallback if no walrusClient) */
    aggregatorUrl?: string | null;
    /** Sui address of the transaction sender, required for Walrus blob writes */
    senderAddress?: string | null;
    /** SealClient — when provided, the vector is created with Seal encryption */
    sealClient?: any | null;
    /** Pre-built SessionKey for Seal operations */
    sessionKey?: any | null;
    /** Keypair or signer to mint a SessionKey when needed */
    signer?: Signer | null;
    /** SessionKey TTL in minutes (default: 5) */
    sealTtlMin?: number;
}

/**
 * Configuration parameters for getCreateTransactionAndReturnVectorInput
 */
export interface GetCreateTransactionParams {
    /** The package ID ('mainnet', 'testnet', or explicit package ID) */
    packageId: string;
}

/**
 * Configuration parameters for push and concat operations
 */
export interface TransactionOptions {
    /** wait for transaction confirmation timeout in ms, default 30000 */
    timeout?: number;
    /** wait for transaction confirmation poll interval in ms, default 1000 */
    pollIntervalMs?: number;
}

/**
 * Configuration parameters for creating an EndlessVectorHistory instance
 */
export interface EndlessVectorHistoryConstructorParams {
    /** Sui gRPC client instance for blockchain interactions */
    suiClient?: SuiGrpcClient;
    /** Unique identifier for this history item */
    id?: string;
    /** Index position of this history item in the sequence */
    index?: number;
    /** Raw field data from the blockchain object */
    fields?: any | null;
    /** Reference to the parent EndlessVector instance */
    endlessVector?: EndlessVector;
    /** Reference to the parent EndlessVectorArchive instance */
    endlessVectorArchive?: EndlessVectorArchive | null;
}

/**
 * Configuration parameters for creating an EndlessVectorArchive instance
 */
export interface EndlessVectorArchiveConstructorParams {
    /** Sui gRPC client instance for blockchain interactions */
    suiClient?: SuiGrpcClient;
    /** ID or address of the EndlessVectorArchive on the Sui blockchain */
    id?: string;
    /** Index position of this archive item in the sequence */
    index?: number;
    /** Reference to the parent EndlessVector instance */
    endlessVector?: EndlessVector;
    /** Raw field data from the blockchain object */
    fields?: any;
}

/**
 * Represents a single item stored in an EndlessVector.
 * Items can be bytes (on-chain), blob (Walrus-stored), or empty.
 */
declare class EndlessVectorItem {
    type: 'bytes' | 'blob' | 'empty';
    meta: Uint8Array;

    constructor(params?: {
        type?: 'bytes' | 'blob' | 'empty';
        bytes?: Uint8Array | null;
        blobData?: any | null;
        meta?: Uint8Array;
        endlessVector?: EndlessVector | null;
        endlessVectorHistory?: EndlessVectorHistory | null;
    });

    get isBytes(): boolean;
    get isBlob(): boolean;
    get isEmpty(): boolean;
    get size(): number;

    bytes(): Promise<Uint8Array>;
    blobData(): any | null;

    static fromGrpcJson(raw: any, context?: {
        endlessVector?: EndlessVector | null;
        endlessVectorHistory?: EndlessVectorHistory | null;
    }): EndlessVectorItem;

    static concatBytes(head: EndlessVectorItem, tail: EndlessVectorItem): Uint8Array;
}

/**
 * Walrus blob read/write companion for EndlessVector.
 * Attached as `endlessVector.walrus` on every EndlessVector instance.
 */
declare class EndlessVectorWalrus {
    constructor(params?: {
        endlessVector?: EndlessVector;
        walrusClient?: any | null;
        publisherUrl?: string | null;
        aggregatorUrl?: string | null;
        senderAddress?: string | null;
    });

    readBlobBytes(blobData: any): Promise<Uint8Array>;
    getPushBlobTransaction(blobObjectId: string, txToAppendTo?: Transaction | null): Transaction;
    pushBlob(data: Uint8Array, params?: {
        epochs?: number;
        deletable?: boolean;
        timeout?: number;
        pollIntervalMs?: number;
    }): Promise<{ blobId: string; blobObjectId: string }>;
}

/**
 * Seal encryption companion for EndlessVector.
 * Attached as `endlessVector.seal` on every EndlessVector instance;
 * only active when a sealClient is supplied at construction time.
 */
declare class EndlessVectorSeal {
    _sessionKey: any | null;

    constructor(params?: {
        endlessVector?: EndlessVector;
        sealClient?: any | null;
        sessionKey?: any | null;
        signer?: any | null;
        sealTtlMin?: number;
    });

    get isEnabled(): boolean;

    static generateAesKey(): Uint8Array;
    setAesKey(key: Uint8Array): void;
    wrapAesKey(aesKey: Uint8Array): Promise<Uint8Array>;
    encryptItem(plaintext: Uint8Array): Promise<Uint8Array>;
    decryptItem(payload: Uint8Array): Promise<Uint8Array>;
}

/**
 * Represents a history item in an EndlessVector, managing a segment of the vector's data.
 */
declare class EndlessVectorHistory {
    suiClient: SuiGrpcClient;
    id: string;
    index: number;

    constructor(params?: EndlessVectorHistoryConstructorParams);

    setFields(fields: any): void;
    isReady(): boolean;
    initialize(): Promise<boolean>;

    get endsAt(): number | undefined;
    get firstItemIsFromPreviousHistory(): boolean;
    get startsAt(): number;
    get followedByNextBytes(): number;

    at(i: number): Promise<Uint8Array>;
    getSuffixStoredBytes(): Promise<Uint8Array>;
}

/**
 * Represents an archive item in an EndlessVector
 */
declare class EndlessVectorArchive {
    suiClient: SuiGrpcClient;
    id: string;
    index: number;
    historyTableId: string | null;
    historyItemsCount: number;

    constructor(params?: EndlessVectorArchiveConstructorParams);

    setFields(fields: any): void;
    isReady(): boolean;

    get length(): number;
    get startsAt(): number;
    get endsAt(): number | undefined;

    initialize(): Promise<boolean>;
    getHistory(historyIndex: number | string): Promise<EndlessVectorHistory>;
    at(i: number): Promise<Uint8Array>;
    getSuffixFromHistoryItemOfIndex(i: number): Promise<Uint8Array>;
}

/**
 * Represents an endless vector data structure that can grow beyond Sui object size limits
 * by storing overflow data in history items.
 */
declare class EndlessVector {
    suiClient: SuiGrpcClient;
    id: string;
    binaryLength: number;
    length: number;
    historyItemsCount: number;
    historyTableId: string | null;
    firstItemIsFromPreviousHistory: boolean;
    archiveTableId: string | null;
    archiveItemsCount: number;
    archivedAtLength: number;
    archivedFromLength: number;
    burnedArchiveCount: number;
    sealEncryptedKey: Uint8Array | null;
    seal: EndlessVectorSeal;
    walrus: EndlessVectorWalrus;

    constructor(params?: EndlessVectorConstructorParams);

    get packageId(): string | null;

    static getPackageId(network: string): string | null;

    isEncrypted(): Promise<boolean>;

    static create(params: EndlessVectorCreateParams): Promise<EndlessVector>;

    static getCreateTransactionAndReturnVectorInput(
        params: GetCreateTransactionParams,
        arr?: Uint8Array | null,
        txToAppendTo?: Transaction | null
    ): Promise<TransactionResult>;

    static composePushTransaction(
        packageId: string,
        vectorInput: TransactionObjectArgument,
        arr: Uint8Array,
        tx: Transaction
    ): Transaction;

    get isWritable(): boolean;
    get firstNotHistoryIndex(): number;

    reInitialize(): void;
    initialize(): Promise<void>;

    getHistory(historyIndex: number | string): Promise<EndlessVectorHistory>;
    getArchive(archiveIndex: number | string): Promise<EndlessVectorArchive>;

    loadHistoryItemsBunch(historyItems: EndlessVectorHistory[]): Promise<void>;
    loadHistoryItem(historyItem: EndlessVectorHistory): Promise<EndlessVectorHistory>;
    loadArchiveItemsBunch(archiveItems: EndlessVectorArchive[]): Promise<void>;
    loadArchiveItem(archiveItem: EndlessVectorArchive): Promise<EndlessVectorArchive>;

    at(i: number): Promise<Uint8Array>;
    getSuffixFromHistoryItemOfIndex(i: number): Promise<Uint8Array | undefined>;

    getPushTransaction(arr: Uint8Array | Uint8Array[], txToAppendTo?: Transaction | null): Transaction;
    push(arr: Uint8Array | Uint8Array[], params?: TransactionOptions): Promise<boolean>;

    getConcatTransaction(
        other: string | EndlessVector | Array<string | EndlessVector>,
        txToAppendTo?: Transaction | null
    ): Transaction;
    concat(other: string | EndlessVector | Array<string | EndlessVector>, params?: TransactionOptions): Promise<boolean>;

    getArchiveTransaction(txToAppendTo?: Transaction | null): Transaction;
    archive(params?: TransactionOptions): Promise<boolean>;

    getBurnArchiveTransaction(txToAppendTo?: Transaction | null): Transaction;
    burnArchive(params?: TransactionOptions): Promise<boolean>;

    executeAndWaitForTransaction(tx: Transaction, params?: {
        timeout?: number;
        pollIntervalMs?: number;
        include?: any;
    }): Promise<any>;
}

export { EndlessVector as default };
export { EndlessVector, EndlessVectorArchive, EndlessVectorHistory, EndlessVectorItem, EndlessVectorWalrus, EndlessVectorSeal };
