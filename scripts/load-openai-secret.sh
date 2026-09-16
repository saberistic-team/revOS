#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! test -f .env.openai.local; then
  echo 'Create .env.openai.local with OPENAI_API_KEY=your-key first.' >&2
  exit 1
fi
kubectl -n agent-engine-local create secret generic openai-secrets --from-env-file=.env.openai.local --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agent-engine-local rollout restart deployment/worker
