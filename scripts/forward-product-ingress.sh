#!/bin/sh
# Reconnect only the local product preview listener after ingress pod restarts.
set -eu
port=${1:-3006}
child=''
trap '[ -z "$child" ] || kill "$child" 2>/dev/null; exit 0' INT TERM
while :; do
  kubectl --context docker-desktop -n product-ingress-system port-forward --address=127.0.0.1 service/product-ingress-traefik "$port:80" &
  child=$!
  wait "$child" || true
  child=''
  sleep 2
done
