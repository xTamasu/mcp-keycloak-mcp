import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { randomUUID } from 'crypto';
import { z } from 'zod';

declare module 'express-serve-static-core' {
  interface Request {
    jwtPayload?: JWTPayload;
  }
}

const KEYCLOAK_ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/mcp-poc';
// KEYCLOAK_JWKS_URI can point to the internal Docker hostname for in-network fetching
// while KEYCLOAK_ISSUER uses the external hostname for token validation and resource metadata.
const KEYCLOAK_JWKS_URI = process.env.KEYCLOAK_JWKS_URI ?? `${KEYCLOAK_ISSUER}/protocol/openid-connect/certs`;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000';
const MCP_AUDIENCE = process.env.MCP_AUDIENCE ?? 'mcp-server';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const JWKS = createRemoteJWKSet(new URL(KEYCLOAK_JWKS_URI));

const app = express();
app.use(express.json());

const KEYCLOAK_REGISTRATION_ENDPOINT = `${KEYCLOAK_JWKS_URI.replace('/protocol/openid-connect/certs', '')}/clients-registrations/openid-connect`;

app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  res.json({
    resource: MCP_SERVER_URL,
    authorization_servers: [KEYCLOAK_ISSUER],
    bearer_methods_supported: ['header'],
  });
});

// Open WebUI derives the DCR endpoint as {mcp_server_base}/register rather than
// following resource_metadata → authorization_server → registration_endpoint.
// This proxy forwards those requests to Keycloak's actual registration endpoint.
app.post('/register', async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(KEYCLOAK_REGISTRATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: 'registration_proxy_error', error_description: msg });
  }
});

async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const wwwAuthenticate = [
    `Bearer realm="${KEYCLOAK_ISSUER}"`,
    `error="invalid_token"`,
    `resource_metadata="${MCP_SERVER_URL}/.well-known/oauth-protected-resource"`,
  ].join(', ');

  if (!authHeader?.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', wwwAuthenticate + ', error_description="Missing Bearer token"');
    res.status(401).json({ error: 'invalid_token', error_description: 'Missing Bearer token' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: KEYCLOAK_ISSUER, audience: MCP_AUDIENCE });
    req.jwtPayload = payload;
    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.set('WWW-Authenticate', wwwAuthenticate + `, error_description="Token verification failed: ${msg}"`);
    res.status(401).json({ error: 'invalid_token', error_description: `Token verification failed: ${msg}` });
  }
}

const transports = new Map<string, StreamableHTTPServerTransport>();

function buildMcpServer(claims?: JWTPayload): McpServer {
  const server = new McpServer({ name: 'keycloak-poc-mcp', version: '1.0.0' });

  server.tool('echo', 'Echoes back the provided message', { message: z.string().describe('Message to echo') }, async ({ message }) => ({
    content: [{ type: 'text' as const, text: `Echo: ${message}` }],
  }));

  server.tool('get-current-time', 'Returns the current UTC time', {}, async () => ({
    content: [{ type: 'text' as const, text: `Current UTC time: ${new Date().toISOString()}` }],
  }));

  server.tool('get-server-info', 'Returns MCP server info', {}, async () => ({
    content: [{ type: 'text' as const, text: `Server: keycloak-poc-mcp v1.0.0 | Protected by: ${KEYCLOAK_ISSUER}` }],
  }));

  server.tool('get-current-user', 'Returns the name of the currently authenticated user', {}, async () => {
    const name = (claims as Record<string, unknown> | undefined)?.['name']
      ?? (claims as Record<string, unknown> | undefined)?.['preferred_username']
      ?? claims?.sub
      ?? 'unknown';
    return { content: [{ type: 'text' as const, text: `Authenticated user: ${name}` }] };
  });

  return server;
}

app.post('/mcp', authenticate, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId)!;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport); },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await buildMcpServer(req.jwtPayload).connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', authenticate, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete('/mcp', authenticate, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
  transports.delete(sessionId);
});

app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
  console.log(`JWKS URI: ${KEYCLOAK_JWKS_URI}`);
  console.log(`Audience: ${MCP_AUDIENCE}`);
  console.log(`Resource metadata: ${MCP_SERVER_URL}/.well-known/oauth-protected-resource`);
});
