#!/usr/bin/env bash
#
# ci-local.sh — run the test suite locally the way .github/workflows/test.yml
# does in CI: start a coturn TURN server, make openssl/Chrome discoverable, run
# `npm test`, then tear coturn down.
#
# Mirrors the CI job's coturn config and credentials so the TURN end-to-end test
# (test/turn-e2e.test.js) actually exercises a relay locally. Dependency-gated
# suites (TURN, DTLS-vs-openssl, browser) skip gracefully if their tool is
# missing, exactly as in CI.
#
# Usage:
#   scripts/ci-local.sh                 # full run (starts coturn, runs npm test)
#   SKIP_INTEGRATION=1 scripts/ci-local.sh   # unit only; no coturn, no interop
#   CHROME_PATH=/path/to/chrome scripts/ci-local.sh   # override Chrome discovery
#
set -uo pipefail

cd "$(dirname "$0")/.."

COTURN_NAME="nodertc-coturn-local"
STARTED_COTURN=0

log()  { printf '\033[36m[ci-local]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ci-local]\033[0m %s\n' "$*"; }

cleanup() {
  if [ "$STARTED_COTURN" = "1" ]; then
    log "Stopping coturn ($COTURN_NAME)"
    docker rm -f "$COTURN_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 1. Toolchain versions (CI: "Show toolchain versions")
# ---------------------------------------------------------------------------
log "Toolchain:"
node --version
npm --version
if command -v openssl >/dev/null 2>&1; then
  openssl version
else
  warn "openssl not found — DTLS interop tests will skip"
fi

# ---------------------------------------------------------------------------
# 2. Chrome discovery (CI: browser-actions/setup-chrome -> CHROME_PATH)
# ---------------------------------------------------------------------------
if [ -z "${CHROME_PATH:-}" ]; then
  for c in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium-browser" \
    "/usr/bin/chromium"; do
    if [ -x "$c" ] || [ -f "$c" ]; then export CHROME_PATH="$c"; break; fi
  done
fi
if [ -n "${CHROME_PATH:-}" ]; then
  log "Chrome: $CHROME_PATH"
else
  warn "Chrome not found — browser interop test will skip (set CHROME_PATH to override)"
fi

# ---------------------------------------------------------------------------
# 3. Start coturn (CI: services.coturn) — same image, ports, creds, realm.
# ---------------------------------------------------------------------------
if [ "${SKIP_INTEGRATION:-0}" = "1" ]; then
  warn "SKIP_INTEGRATION=1 — not starting coturn; integration suites will skip"
elif ! command -v docker >/dev/null 2>&1; then
  warn "docker not found — not starting coturn; TURN test will skip"
elif ! docker info >/dev/null 2>&1; then
  warn "docker daemon not reachable — not starting coturn; TURN test will skip"
else
  log "Starting coturn ($COTURN_NAME) on 3478"
  docker rm -f "$COTURN_NAME" >/dev/null 2>&1 || true
  if docker run -d --name "$COTURN_NAME" \
      -p 3478:3478/udp -p 3478:3478/tcp \
      coturn/coturn:latest \
      -n --listening-port=3478 --fingerprint --lt-cred-mech \
      --user=testuser:testpass --user=nodertc:nodertcpass \
      --realm=nodertc.local --no-tls --no-dtls >/dev/null 2>&1; then
    STARTED_COTURN=1
    # CI: "Verify TURN server" — wait until the port answers.
    log "Waiting for coturn to accept connections..."
    for i in $(seq 1 10); do
      if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 3478 2>/dev/null; then break; fi
      sleep 1
    done
    sleep 1  # let the UDP listener settle
  else
    warn "Failed to start coturn — TURN test will skip"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Run the suite (CI: "Run all tests" -> npm test)
# ---------------------------------------------------------------------------
log "Running: npm test"
npm test
status=$?

if [ $status -eq 0 ]; then
  log "All tests passed."
else
  warn "Tests failed (exit $status)."
fi
exit $status
