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

**One-time host setup** — add `keycloak` to your `/etc/hosts` so the browser can reach Keycloak at the same hostname that containers use internally:

```bash
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts
```

Then start the stack:

```bash
cp .env.example .env
# Edit .env to set WEBUI_SECRET_KEY to a strong random string
docker compose down -v   # clear any previous Keycloak volume
docker compose up --build
```

Services start in order: Keycloak (health-checked) → MCP Server + Open WebUI.

| Service    | URL                                  | Credentials           |
|------------|--------------------------------------|-----------------------|
| Keycloak   | http://keycloak:8080     | admin / adminpassword |
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

Set the MCP auth type to **OAuth** — Open WebUI will then automatically forward the logged-in user's Keycloak token to the MCP server.

1. Log in to Open WebUI at http://localhost:3001
2. Go to **Admin Settings → External Connections → MCP**
3. Click **Add Connection** and fill in:
   - **URL**: `http://mcp-server:3000/mcp`
   - **Auth Type**: `OAuth`
4. Click **Save**

> **Prerequisite:** Open WebUI must itself be logged in via Keycloak OIDC (i.e. `OPENID_PROVIDER_URL` is set in Docker Compose). The user's token is then already present and forwarded directly — no additional OAuth flow needed.

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

- **Open WebUI auth type "OAuth"**: Requires Open WebUI to be connected via Keycloak OIDC. If Open WebUI is not running with OIDC, the MCP connection will have no token to forward.
- **`sslRequired: none`**: This realm export disables SSL requirements for local development. Never use this in production.
- **Hardcoded secrets in realm-export.json**: The client secrets in `realm-export.json` are defaults for local PoC use. Rotate them via Keycloak Admin → Clients → Credentials before any shared deployment.
- **`/etc/hosts` entry required**: `KC_HOSTNAME` is set to `keycloak` (the Docker-internal service name). Inside containers, Docker DNS resolves `keycloak` to the Keycloak container. On the host, `127.0.0.1 keycloak` in `/etc/hosts` makes the same hostname reach port-mapped Keycloak. This is the simplest way to share one URL between browser and containers without platform-specific helpers like `host.docker.internal`.
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
