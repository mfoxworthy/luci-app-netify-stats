#!/bin/sh
# Run the pure-transform unit tests with Node. Runs wherever node is available
# (locally if installed, else on the build host via ssh).
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
    node "$HERE/tests/run.js"
else
    echo ">> node not local; running on build host"
    HOST="${NSP_BUILD_HOST:-mfoxworthy@10.0.4.220}"
    REMOTE="${NSP_LUCI_REMOTE:-/home/mfoxworthy/luci-app-netify-stats-build}"
    rsync -az --delete --exclude '.git/' "$HERE"/ "$HOST:$REMOTE"/
    ssh -o BatchMode=yes "$HOST" "cd '$REMOTE' && node tests/run.js"
fi
