#!/usr/bin/env bash
# Kick off the accounts + Stripe webhook build with Claude Code.
# Usage:  ./start-build.sh          (both phases)
#         ./start-build.sh 1        (webhook only)
#         ./start-build.sh 2        (accounts only)
set -e

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code not found. Install it first:"
  echo "  npm install -g @anthropic-ai/claude-code"
  exit 1
fi

PHASE="${1:-all}"
case "$PHASE" in
  1)   TASK="Read BUILD_SPEC.md and implement Phase 1 only (the Stripe webhook). Stop when its acceptance criteria pass." ;;
  2)   TASK="Read BUILD_SPEC.md and implement Phase 2 only (accounts and database). Phase 1 is already done. Stop when its acceptance criteria pass." ;;
  all) TASK="Read BUILD_SPEC.md and implement it. Do Phase 1 first, verify its acceptance criteria, then do Phase 2." ;;
  *)   echo "Usage: ./start-build.sh [1|2]"; exit 1 ;;
esac

echo "Starting Claude Code — phase: $PHASE"
claude "$TASK Work through it step by step, run 'npm run build' after each phase, and ask me before installing any dependency not named in the spec."
