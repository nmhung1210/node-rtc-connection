#!/usr/bin/env bash
#
# ci-local.sh — run the test suite locally like .github/workflows/test.yml.
# Ensures Playwright's Chromium is installed, then runs `npm test`, which itself
# starts/stops a coturn TURN server for the relay test (see run-all-tests.js).
# Dependency-gated suites (TURN, DTLS-vs-openssl, browser) skip gracefully if
# their tool is missing.
#
#   scripts/ci-local.sh                     # full run
#   SKIP_INTEGRATION=1 scripts/ci-local.sh  # unit only (no coturn, no browser)
#
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "${SKIP_INTEGRATION:-0}" != "1" ]; then
  # Playwright Chromium for the browser interop test.
  node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 \
    || npx playwright install chromium >/dev/null 2>&1 \
    || echo "[ci-local] Chromium unavailable — browser test will skip"
fi

npm test
