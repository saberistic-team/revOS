#!/bin/sh
# Keep a local-only service URL connected across Kubernetes pod restarts.
set -eu
service=${1:?Usage: forward-local-service.sh SERVICE LOCAL_PORT REMOTE_PORT}
local_port=${2:?Local port required}
remote_port=${3:?Remote port required}
trap 'exit 0' INT TERM
while :; do
  kubectl --context docker-desktop -n agent-engine-local port-forward "service/$service" "$local_port:$remote_port" || true
  sleep 2
done
