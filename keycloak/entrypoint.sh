#!/bin/bash
set -e

# Start Keycloak in the background
/opt/keycloak/bin/kc.sh start-dev --import-realm &
KC_PID=$!

# Wait for Keycloak management port (9000) to be ready.
# curl/wget are not in the Keycloak image, so we use bash's /dev/tcp.
echo "Waiting for Keycloak to start..."
until bash -c "exec 3<>/dev/tcp/localhost/9000 && \
  echo -e 'GET /health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3 && \
  cat <&3 | grep -q '\"status\": \"UP\"'" 2>/dev/null; do
  sleep 2
done
echo "Keycloak ready — disabling sslRequired on master realm..."

# Disable HTTPS requirement on master realm so the admin console
# and token endpoints are reachable over plain HTTP from any IP.
# This is safe for local dev; never do this in production.
/opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "${KEYCLOAK_ADMIN}" \
  --password "${KEYCLOAK_ADMIN_PASSWORD}"

/opt/keycloak/bin/kcadm.sh update realms/master -s sslRequired=NONE

echo "sslRequired=NONE applied to master realm."

wait $KC_PID
