# Endless Vector

Infinite `vector<vector<u8>>`

A scalable binary vector data structure for the Sui blockchain that can grow beyond Sui's object size limits through an intelligent archival system.

## Overview

Endless Vector solves the problem of Sui's object size [constraints](https://move-book.com/guides/building-against-limits.html/) (250KB max object size, 128KB max transaction size) by implementing a multi-tiered storage architecture. It automatically manages data across three layers:

- **Current Items**: Most recent data stored directly in the object
- **History**: Older data moved to table storage for efficient access
- **Archive**: Historical data archived for long-term storage with optional pruning

## Features

- **Unlimited Growth**: Automatically handles Sui's size constraints through intelligent data management
- **Efficient Access**: Optimized for recent data access while maintaining historical records
- **Archive Management**: Support for burning old archived data to reduce storage costs
- **Binary Data**: Stores arbitrary binary data (`vector<vector<u8>>`) making it suitable for various use cases
- **JavaScript SDK**: Easy-to-use client library for interacting with the smart contract
- **Parallel Transaction Support**: Ready for parallel transactions to create concatenated vector
- **Tested**: Move unit tests and JS integration tests

## Documentation

- **[JavaScript SDK Documentation](js/README.md)** - Detailed API reference and usage examples for the JavaScript/TypeScript SDK
- **[Move Smart Contract Documentation](move/README.md)** - Complete guide to the Move contract functions and architecture

## Author

[suidouble](https://github.com/suidouble)

## Keywords

sui, vector, database, storage, sui.js, web3, dapps, blockchain
