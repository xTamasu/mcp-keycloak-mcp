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
echo "Keycloak ready — applying post-import configuration..."

/opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "${KEYCLOAK_ADMIN}" \
  --password "${KEYCLOAK_ADMIN_PASSWORD}"

# 1. Disable HTTPS requirement on master realm so the admin console
#    is reachable over plain HTTP from any IP (local dev only).
/opt/keycloak/bin/kcadm.sh update realms/master -s sslRequired=NONE
echo "sslRequired=NONE applied to master realm."

# 2. Remove the anonymous "Trusted Hosts" client registration policy from
#    the mcp-poc realm so OpenCode can perform Dynamic Client Registration
#    (RFC 7591) without needing a pre-issued Initial Access Token.
#    The realm import recreates this restrictive policy on every cold start.
LAST_ID=""
while IFS= read -r LINE; do
  if [[ "$LINE" =~ \"id\"\ :\ \"([^\"]+)\" ]]; then
    LAST_ID="${BASH_REMATCH[1]}"
  fi
  if [[ "$LINE" =~ \"trusted-hosts\" ]] && [[ -n "$LAST_ID" ]]; then
    /opt/keycloak/bin/kcadm.sh delete "components/${LAST_ID}" -r mcp-poc 2>/dev/null && \
      echo "Removed anonymous Trusted Hosts policy (${LAST_ID})."
    LAST_ID=""
  fi
done < <(/opt/keycloak/bin/kcadm.sh get "components" -r mcp-poc \
  --fields id,providerId,subType 2>/dev/null)

echo "Post-import configuration complete."

wait $KC_PID
