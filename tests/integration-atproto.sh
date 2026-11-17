#!/bin/bash
# Integration tests: tools/atproto scripts (offline; mock servers only, never the real PDS)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

PROJECT_ROOT="${1:-.}"
cd "$PROJECT_ROOT" || exit 1

# Every script parses
SYNTAX_ERRORS=0
for f in tools/atproto/*.mjs; do
    node --check "$f" 2>/dev/null || { echo "syntax error: $f"; SYNTAX_ERRORS=$((SYNTAX_ERRORS + 1)); }
done
[ "$SYNTAX_ERRORS" -eq 0 ]
test_result $? "All tools/atproto scripts parse"

# The SDKs are declared dependencies and resolve
node -e "import('@atproto/api').then(()=>import('@atproto/identity'))" 2>/dev/null
test_result $? "@atproto/api and @atproto/identity are installed"

# No hand-built XRPC URLs or atproto-proxy headers outside the documented exceptions
# (Semble, Constellation and Tangled's Bobbin are plain HTTP; Jetstream is a WebSocket).
if grep -n "/xrpc/\|atproto-proxy" tools/atproto/*.mjs \
    | grep -v "notifications-semble.mjs\|notifications-tangled.mjs\|^tools/atproto/[a-z-]*.mjs:[0-9]*:\s*//" | grep -q .; then
    false
else
    true
fi
test_result $? "No hand-built /xrpc/ URLs or atproto-proxy headers outside Semble/Tangled"

# Unit tests (node:test, TAP output): one result per test
TAP=$(node --test --test-reporter=tap tests/atproto/*.test.mjs 2>&1)
while IFS= read -r line; do
    case "$line" in
        "ok "*)     test_result 0 "atproto: ${line#ok [0-9]* - }" ;;
        "not ok "*) test_result 1 "atproto: ${line#not ok [0-9]* - }" ;;
    esac
done <<< "$TAP"

print_summary
