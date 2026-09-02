#!/bin/bash
echo "Watching proxy... (Ctrl+C to stop)"
echo "Current requests: $(curl -s http://localhost:8796/stats/requests | jq '.requests | length')"
echo ""
echo "Waiting for new requests..."
while true; do
  sleep 1
  count=$(curl -s http://localhost:8796/stats/requests | jq '.requests | length')
  if [ "$count" -gt 1 ]; then
    echo "✅ NEW REQUEST! Total: $count"
    curl -s http://localhost:8796/stats/requests | jq '.requests[-1]'
    break
  fi
done
