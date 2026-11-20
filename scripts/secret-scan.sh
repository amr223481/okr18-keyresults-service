#!/usr/bin/env bash
# ---------------------------------------------------------------
# ST9: secret scan of every team repo before submission.
# Looks in each repo's Git-tracked files AND its whole commit history for things
# that must never be committed: AWS keys, private keys, real Turnstile secrets,
# database URLs with passwords, and committed .env files.
# Run from this repo:   bash scripts/secret-scan.sh            (scans ../okr18-*)
# ---------------------------------------------------------------
set -uo pipefail
PATTERNS='AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|aws_secret_access_key *= *[A-Za-z0-9/+]{40}|0x4AAA[0-9A-Za-z_-]{20,}|postgres(ql)?://[^:]+:[^@]+@|"?(password|secret|api_?key)"? *[:=] *"[^"$ ]{12,}"'
# Allowed on purpose: Floci's fake "test" keys and Cloudflare's PUBLIC test keys (1x0000...AA)
FOUND=0
for repo in ../okr18-*/; do
  [ -d "$repo/.git" ] || { echo "skip  $repo (not a git repo yet)"; continue; }
  name=$(basename "$repo")
  hits=$(git -C "$repo" grep -nIE "$PATTERNS" -- . ':!package-lock.json' ':!*.test.js' 2>/dev/null || true)
  hist=$(git -C "$repo" log -p --all -G"$PATTERNS" --pretty=format:'%h' -- . ':!package-lock.json' ':!*.test.js' 2>/dev/null | grep -E "^\+.*($PATTERNS)" || true)
  envs=$(git -C "$repo" ls-files | grep -E '(^|/)\.env$' || true)
  if [ -z "$hits$hist$envs" ]; then
    echo "PASS  $name: no secrets in tracked files or history, no .env committed"
  else
    FOUND=1
    echo "FAIL  $name"
    [ -n "$hits" ] && echo "$hits" | sed 's/^/      file: /'
    [ -n "$hist" ] && echo "$hist" | sed 's/^/      history: /'
    [ -n "$envs" ] && echo "$envs" | sed 's/^/      committed .env: /'
  fi
done
exit $FOUND
