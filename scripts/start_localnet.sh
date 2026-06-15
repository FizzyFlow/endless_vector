#!/usr/bin/env bash
#
# Launch the seal_walrus_localnet server (local Sui validator + Walrus relay/aggregator
# + Seal key server) with THIS repo's Move package (../move) deployed as the contract.
#
# The endless_vector package is published with its unpublished Walrus + WAL dependencies,
# so the endless_walrus, walrus and wal modules all land under one package id — printed in
# the "ENDLESS_VECTOR LOCALNET CONFIG" block as `packageId`.
#
# Usage:
#   ./scripts/start_localnet.sh
#   ./scripts/start_localnet.sh --port 8099 --debug
#
# Press Ctrl-C to stop. Requires the seal_walrus_localnet repo checked out next to this
# one (../../seal_walrus_localnet) with its dependencies installed (`pnpm install` there).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOVE_PKG="$(cd "$SCRIPT_DIR/../move" && pwd)"
LOCALNET_DIR="$(cd "$SCRIPT_DIR/../../seal_walrus_localnet" && pwd)"

if [ ! -f "$LOCALNET_DIR/start.js" ]; then
    echo "error: seal_walrus_localnet not found at $LOCALNET_DIR (expected ../../seal_walrus_localnet/start.js)" >&2
    exit 1
fi

echo "[start_localnet] move package: $MOVE_PKG"
echo "[start_localnet] localnet:     $LOCALNET_DIR"

# start.js reads the package path from SEAL_WALRUS_PACKAGE and publishes it (with its
# unpublished Walrus/WAL deps). Run from the localnet dir so its node_modules resolve.
export SEAL_WALRUS_PACKAGE="$MOVE_PKG"
cd "$LOCALNET_DIR"
exec node start.js "$@"
