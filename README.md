# Keycloak-Secured MCP Server — OAuth 2.1 PoC

A minimal, runnable proof-of-concept showing a **Model Context Protocol (MCP) server** protected by **Keycloak OAuth 2.1**, compatible with both **OpenCode** and **Open WebUI**.

## Architecture

```
                         ┌─────────────────────────────────────────────────────┐
                         │                  Docker Network (mcp-net)            │
                         │                                                       │
  ┌──────────┐  401+WWW  │  ┌─────────────┐   verify JWT    ┌──────────────┐   │
  │ OpenCode │ ─────────►│  │  MCP Server  │ ─────────────►  │   Keycloak   │   │
  │  (host)  │ ◄─────────│  │  :3000/mcp   │                 │   :8080      │   │
  └──────────┘  token+re │  └─────────────┘                  │ realm:mcp-poc│   │
       │        quest    │         ▲                          └──────────────┘   │
       │                 │         │                                 ▲            │
       │  browser        │         │                                 │            │
       └──── OAuth ──────┼─────────┼─────────────────────────────── ┘            │
            redirect     │         │                                              │
                         │  ┌──────┴──────┐   Bearer token                      │
                         │  │ Open WebUI  │ ──────────────────────────────►      │
                         │  │  :3001      │       MCP tool calls                 │
                         │  └─────────────┘                                      │
                         └─────────────────────────────────────────────────────┘

  OAuth Clients registered in Keycloak:
    • mcp-server      — confidential, PKCE S256 (resource server)
    • openwebui-client — confidential, PKCE S256 (Open WebUI backend)
    • opencode-client  — public, PKCE S256 required (OpenCode CLI)
```

## Quick Start

```bash
cp .env.example .env
# Edit .env to set WEBUI_SECRET_KEY to a strong random string
docker compose up --build
```

Services start in order: Keycloak (health-checked) → MCP Server + Open WebUI.

| Service    | URL                                  | Credentials           |
|------------|--------------------------------------|-----------------------|
| Keycloak   | http://host.docker.internal:8080     | admin / adminpassword |
| MCP Server | http://localhost:3000                | —                     |
| Open WebUI | http://localhost:3001                | see below             |

**Test user**: `testuser` / `testpassword`

### Verify the MCP server is protected

```bash
# Should return 401 with WWW-Authenticate header
curl -i http://localhost:3000/mcp -X POST -H "Content-Type: application/json" -d '{}'

# Should return resource metadata JSON
curl http://localhost:3000/.well-known/oauth-protected-resource
```

## OpenCode Configuration

OpenCode handles the OAuth flow automatically when it encounters a 401. Add this to your `~/.config/opencode/opencode.jsonc` (or local `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "keycloak-poc": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "client_id": "opencode-client"
    }
  }
}
```

### OpenCode OAuth Flow (first run)

1. OpenCode sends a request to `http://localhost:3000/mcp`
2. MCP server responds **401** with `WWW-Authenticate` header pointing to Keycloak
3. OpenCode reads `/.well-known/oauth-protected-resource` to discover the authorization server
4. OpenCode opens a browser tab → Keycloak login page
5. You log in as `testuser` / `testpassword`
6. Keycloak redirects to `http://127.0.0.1:19876/mcp/oauth/callback`
7. OpenCode stores the token securely; subsequent requests include `Authorization: Bearer <token>`
8. Tools (`echo`, `get-current-time`, `get-server-info`) are now available

## Open WebUI Configuration

### Option 1 — OAuth 2.1 Static (Recommended)

Configure once in the Admin panel so all users share the same OAuth client credentials:

1. Log in to Open WebUI at http://localhost:3001 (create an account on first visit)
2. Go to **Admin Settings → External Connections → MCP**
3. Click **Add Connection** and fill in:
   - **URL**: `http://mcp-server:3000/mcp`
   - **Auth Type**: `OAuth 2.1 (Static)`
   - **OAuth Server URL**: `http://host.docker.internal:8080/realms/mcp-poc`
   - **Client ID**: `openwebui-client`
   - **Client Secret**: `openwebui-secret`
   - **Scope**: `openid profile email`
4. Click **Save** — Open WebUI fetches the OIDC discovery doc and performs the client credentials / auth-code flow on behalf of users.

### Option 2 — Bearer Token Fallback

Use this as a workaround for Open WebUI's known per-user PKCE bugs (see Known Limitations below):

```bash
# Get a token directly from Keycloak using the test user
TOKEN=$(curl -s -X POST \
  http://host.docker.internal:8080/realms/mcp-poc/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=opencode-client&grant_type=password&username=testuser&password=testpassword&scope=openid" \
  | jq -r .access_token)

# Use the token directly with the MCP server
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

In Open WebUI, paste the token as a **Bearer token** in the connection settings instead of using OAuth flow.

## Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `echo` | Echoes a message back | `message: string` |
| `get-current-time` | Returns current UTC timestamp | — |
| `get-server-info` | Returns server name and Keycloak issuer | — |

## Token Lifespans

| Token | Lifespan |
|-------|----------|
| Access token | 5 minutes |
| SSO session / refresh token | 30 minutes |

## Known Limitations

- **Open WebUI per-user OAuth (PKCE bug)**: As of early 2026, Open WebUI has active issues with per-user OAuth flows involving PKCE (`code_challenge`/`code_verifier` mismatch across redirects). Use the **Static OAuth** admin configuration (Option 1) or the **Bearer Token fallback** (Option 2) instead.
- **`sslRequired: none`**: This realm export disables SSL requirements for local development. Never use this in production.
- **Hardcoded secrets in realm-export.json**: The client secrets in `realm-export.json` are defaults for local PoC use. Rotate them via Keycloak Admin → Clients → Credentials before any shared deployment.
- **`host.docker.internal` requirement**: `KC_HOSTNAME` is set to `host.docker.internal` so that Keycloak's token and authorization URLs are reachable both from the host browser and from other containers (Open WebUI's server-side token exchange). This is provided automatically by Docker Desktop on Mac/Windows. On Linux Docker Engine, add `extra_hosts: ["host.docker.internal:host-gateway"]` to each service in `docker-compose.yml`.
- **MCP_SERVER_URL = localhost**: The `MCP_SERVER_URL` env var defaults to `http://localhost:3000` (the host-facing URL). Inside the Docker network, services talk to `http://mcp-server:3000`. Adjust if deploying remotely.

## Environment Variables

Copy `.env.example` to `.env` and customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `KEYCLOAK_ADMIN` | `admin` | Keycloak admin username |
| `KEYCLOAK_ADMIN_PASSWORD` | `adminpassword` | Keycloak admin password |
| `WEBUI_SECRET_KEY` | *(must set)* | 32+ char secret for Open WebUI session tokens |
| `OPENWEBUI_OAUTH_CLIENT_SECRET` | `openwebui-secret` | Matches `openwebui-client` in Keycloak |
| `MCP_SERVER_CLIENT_SECRET` | `mcp-server-secret` | Matches `mcp-server` client in Keycloak |
