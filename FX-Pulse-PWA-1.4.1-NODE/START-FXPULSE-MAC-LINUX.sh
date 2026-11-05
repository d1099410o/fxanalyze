#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node -e "const v=Number(process.versions.node.split('.')[0]); if(v<20){console.error('Wymagany Node.js 20 lub nowszy.'); process.exit(1)}"
node scripts/setup.mjs
node scripts/smoke-test.mjs
exec node server.js
