#!/bin/sh
set -e

# Start VCP signing proxy if TESLA_PRIVATE_KEY is available.
# The proxy signs commands with the EC private key so newer Tesla vehicles
# (which require Vehicle Command Protocol) accept climate/charging/window commands.

if [ -n "$TESLA_PRIVATE_KEY" ]; then
  echo "[entrypoint] Starting VCP signing proxy..."

  # Generate a self-signed TLS cert for the local proxy (localhost only)
  openssl req -x509 -newkey ec \
    -pkeyopt ec_paramgen_curve:P-256 \
    -keyout /tmp/proxy-tls.key \
    -out /tmp/proxy-tls.crt \
    -days 3650 -nodes \
    -subj '/CN=localhost' 2>/dev/null

  # Write the fleet private key (handle both literal \n and real newlines)
  printf '%s' "$TESLA_PRIVATE_KEY" | sed 's/\\n/\n/g' > /tmp/fleet.pem

  # Start proxy on localhost:4443
  tesla-http-proxy \
    -tls-key /tmp/proxy-tls.key \
    -cert /tmp/proxy-tls.crt \
    -key-file /tmp/fleet.pem \
    -host 127.0.0.1 \
    -port 4443 &

  PROXY_PID=$!
  sleep 2

  if kill -0 $PROXY_PID 2>/dev/null; then
    echo "[entrypoint] VCP proxy running (pid $PROXY_PID) — climate/charging/windows will be signed"
    export VCP_PROXY_AVAILABLE=1
  else
    echo "[entrypoint] VCP proxy failed to start — VCP commands will not be signed"
  fi
else
  echo "[entrypoint] TESLA_PRIVATE_KEY not set — VCP commands disabled"
fi

exec node dist/siri-server.js
