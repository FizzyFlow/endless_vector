import type { SuiClient, GetObjectParams, GetDynamicFieldsParams } from '@mysten/sui/client';
import type { Transaction, TransactionResult, TransactionObjectArgument } from '@mysten/sui/transactions';

/**
 * Custom function to sign and execute transactions
 */
export type CustomSignAndExecuteTransactionFunction = (tx: Transaction) => Promise<string>;

/**
 * Configuration parameters for creating an EndlessVector instance
 */
export interface EndlessVectorConstructorParams {
    /** Sui client instance for blockchain interactions */
    suiClient?: SuiClient;
    /** ID or address of the EndlessVector on the Sui blockchain */
    id?: string;
    /** Adds write capability if provided, ID of the Move package containing the EndlessVector module or 'mainnet', 'testnet' to use known IDs */
    packageId?: string | null;
    /** Adds write capability if provided, function should accept Sui transaction, sign and submit it to the blockchain and return its digest */
    signAndExecuteTransaction?: CustomSignAndExecuteTransactionFunction | null;
}

/**
 * Configuration parameters for creating a new EndlessVector via static create method
 */
export interface EndlessVectorCreateParams {
    /** Sui client instance for blockchain interactions */
    suiClient: SuiClient;
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
    /** Sui client instance for blockchain interactions */
    suiClient?: SuiClient;
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
    /** Sui client instance for blockchain interactions */
    suiClient?: SuiClient;
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
 * Represents a history item in an EndlessVector, managing a segment of the vector's data.
 * Each history item stores a portion of the vector's elements and maintains metadata
 * about its position and relationships with adjacent history items.
 */
export declare class EndlessVectorHistory {
    suiClient: SuiClient;
    id: string;
    index: number;

    constructor(params?: EndlessVectorHistoryConstructorParams);

    /**
     * Sets the fields data for this history item. Called by loader of EndlessVector.
     */
    setFields(fields: any): void;

    /**
     * Checks if this history item has been initialized and is ready for use.
     */
    isReady(): boolean;

    /**
     * Initializes this history item by loading its data from the blockchain.
     * Uses promise-based synchronization to prevent multiple concurrent initializations.
     */
    initialize(): Promise<boolean>;

    /**
     * Gets the last index position that this history item covers.
     */
    get endsAt(): number | undefined;

    /**
     * Indicates whether the first item in this history contains suffix bytes that should be
     * added to the last item from the previous history segment.
     */
    get firstItemIsFromPreviousHistory(): boolean;

    /**
     * Gets the first index position that this history item covers.
     */
    get startsAt(): number;

    /**
     * Gets the number of bytes from the next history item that should be appended
     * to the last item in this history segment.
     */
    get followedByNextBytes(): number;

    /**
     * Retrieves the byte array at the specified index within this history segment.
     */
    at(i: number): Promise<Uint8Array>;

    /**
     * Gets the suffix bytes stored in this history item that should be appended
     * to the last item of the previous history segment.
     */
    getSuffixStoredBytes(): Uint8Array;
}

/**
 * Represents an archive item in an EndlessVector
 */
export declare class EndlessVectorArchive {
    suiClient: SuiClient;
    id: string;
    index: number;
    historyTableId: string | null;
    historyItemsCount: number;

    constructor(params?: EndlessVectorArchiveConstructorParams);

    /**
     * Sets the fields data for this archive item. Called by loader of EndlessVector.
     */
    setFields(fields: any): void;

    /**
     * Checks if this archive item has been initialized and is ready for use.
     */
    isReady(): boolean;

    /**
     * Gets the total number of items stored in this archive.
     */
    get length(): number;

    /**
     * Gets the first index position that this archive covers.
     */
    get startsAt(): number;

    /**
     * Gets the last index position that this archive covers.
     */
    get endsAt(): number | undefined;

    /**
     * Initializes this archive item by loading its data from the blockchain.
     */
    initialize(): Promise<boolean>;

    /**
     * Gets a history item within this archive by its index.
     */
    getHistory(historyIndex: number | string): Promise<EndlessVectorHistory>;

    /**
     * Retrieves the byte array at the specified index within this archive.
     */
    at(i: number): Promise<Uint8Array>;

    /**
     * Gets suffix bytes from a history item at the specified index within this archive.
     */
    getSuffixFromHistoryItemOfIndex(i: number): Promise<Uint8Array>;
}

/**
 * Represents an endless vector data structure that can grow beyond Sui object size limits
 * by storing overflow data in history items. Provides seamless access to all elements regardless
 * of whether they're stored in the current object or historical segments.
 */
export declare class EndlessVector {
    suiClient: SuiClient;
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

    constructor(params?: EndlessVectorConstructorParams);

    /**
     * Static factory method to create a new empty EndlessVector on the blockchain.
     */
    static create(params: EndlessVectorCreateParams): Promise<EndlessVector>;

    /**
     * Creates an empty EndlessVector and returns the vector input reference.
     */
    static getCreateTransactionAndReturnVectorInput(
        params: GetCreateTransactionParams,
        arr?: Uint8Array | null,
        txToAppendTo?: Transaction | null
    ): Promise<TransactionResult>;

    /**
     * Attach move calls to transaction, to push item into endlessvector, handling large arrays by chunking them.
     */
    static composePushTransaction(
        packageId: string,
        vectorInput: TransactionObjectArgument,
        arr: Uint8Array,
        tx: Transaction
    ): Transaction;

    /**
     * Check if the EndlessVector instance is writable
     */
    get isWritable(): boolean;

    /**
     * Gets the first index that is stored in the current EndlessVector object (not in history items).
     */
    get firstNotHistoryIndex(): number;

    /**
     * Forces re-initialization of the EndlessVector to reload data from the blockchain.
     */
    reInitialize(): void;

    /**
     * Initializes the EndlessVector by loading data from the Sui blockchain.
     */
    initialize(): Promise<void>;

    /**
     * Gets a history item by its index, loading it from the blockchain if needed.
     */
    getHistory(historyIndex: number | string): Promise<EndlessVectorHistory>;

    /**
     * Gets an archive item by its index, loading it from the blockchain if needed.
     */
    getArchive(archiveIndex: number | string): Promise<EndlessVectorArchive>;

    /**
     * Loads multiple history items in a single batch request for efficiency.
     */
    loadHistoryItemsBunch(historyItems: EndlessVectorHistory[]): Promise<void>;

    /**
     * Loads a single history item, batching requests for efficiency.
     */
    loadHistoryItem(historyItem: EndlessVectorHistory): Promise<EndlessVectorHistory>;

    /**
     * Loads multiple archive items in a single batch request for efficiency.
     */
    loadArchiveItemsBunch(archiveItems: EndlessVectorArchive[]): Promise<void>;

    /**
     * Loads a single archive item, batching requests for efficiency.
     */
    loadArchiveItem(archiveItem: EndlessVectorArchive): Promise<EndlessVectorArchive>;

    /**
     * Retrieves the byte array at the specified index from either current items or history.
     */
    at(i: number): Promise<Uint8Array>;

    /**
     * Gets suffix bytes from a history item at the specified index.
     */
    getSuffixFromHistoryItemOfIndex(i: number): Promise<Uint8Array | undefined>;

    /**
     * Creates a transaction to push new byte arrays to the EndlessVector.
     */
    getPushTransaction(arr: Uint8Array | Uint8Array[], txToAppendTo?: Transaction | null): Transaction;

    /**
     * Pushes new byte array to the EndlessVector, creating and executing the necessary transaction.
     */
    push(arr: Uint8Array | Uint8Array[], params?: TransactionOptions): Promise<boolean>;

    /**
     * Creates a transaction to concatenate EndlessVector(s) into this one.
     */
    getConcatTransaction(
        other: string | EndlessVector | Array<string | EndlessVector>,
        txToAppendTo?: Transaction | null
    ): Transaction;

    /**
     * Concatenates EndlessVector(s) into this one, creating and executing the necessary transaction.
     */
    concat(other: string | EndlessVector | Array<string | EndlessVector>, params?: TransactionOptions): Promise<boolean>;
}

export { EndlessVector as default };
export { EndlessVector, EndlessVectorArchive, EndlessVectorHistory };
