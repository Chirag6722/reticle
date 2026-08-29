#!/usr/bin/env bash
# The smallest thing that reddens if the gates break. No framework.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); tmp=$(mktemp -d); fails=0
ok() { printf '  ok   %s\n' "$1"; }
no() { printf '  FAIL %s\n  %s\n' "$1" "$2"; fails=$((fails+1)); }
check() { case "$2" in *"$3"*) ok "$1";; *) no "$1" "$2";; esac; }

out=$(cd "$tmp" && bash "$here/onboard.sh" 2>&1); check "no package.json stops" "$out" "no package.json"

echo '{"scripts":{"build":"x"}}' > "$tmp/package.json"
out=$(cd "$tmp" && bash "$here/onboard.sh" 2>&1); check "no dev script stops" "$out" "no dev/start/serve script"

s='{"sessions":[{"sessionId":"other","url":"http://localhost:9999/"},{"sessionId":"mine","url":"http://localhost:5173/x"}]}'
check "picks the session on OUR url" "$(printf '%s' "$s" | node "$here/pick-session.mjs" http://localhost:5173)" "mine"
got=$(printf '%s' "$s" | node "$here/pick-session.mjs" http://localhost:4321)
[ -z "$got" ] && ok "no match is empty, not somebody else's tab" || no "no match is empty" "$got"
[ -z "$(printf 'not json' | node "$here/pick-session.mjs" http://x)" ] && ok "garbage status is empty" || no "garbage status" "leaked"

rm -rf "$tmp"; [ $fails -eq 0 ] && echo "PASS" || { echo "$fails FAILED"; exit 1; }
