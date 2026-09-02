#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { loadConfig, type ServerConfig } from '../core/config.js'
import { logStderr } from '../core/logger.js'
import { ALL_TOOLS } from '../tools/index.js'
import { buildServer } from '../server.js'
import { TenantStore } from '../http/tenant-store.js'

const MCP_PATH = '/mcp'

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
  res.end(text)
}

/**
 * A JSON-RPC-shaped error response for a failure that happens before the
 * request ever reaches the MCP transport (missing credentials, an
 * unparseable body). `id: null` per the JSON-RPC spec for an error that
 * cannot be tied to a request id. The `message` here is the only thing this
 * server ever puts in an error body - never the token, never a raw upstream
 * error, never anything derived from the request body itself.
 */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } })
}

/**
 * Finishes a request that failed inside `handleMcpRequest`'s outer `try`,
 * after `transport.handleRequest` may already have started writing a
 * response. When no bytes have gone out yet, this is a normal structured
 * error. When headers are already sent - `transport.handleRequest` started
 * streaming a response and then failed partway through - a second
 * `writeHead`/JSON body is impossible, and simply returning (the previous
 * behaviour) left the connection open with no further data ever coming,
 * hanging the client. `destroy()` closes it immediately instead; there is
 * no well-formed error body to send at that point anyway.
 */
export function failRequest(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.destroy()
    }
    return
  }
  sendRpcError(res, status, message)
}

/**
 * A generous but bounded ceiling on one request body, read entirely into
 * memory before being handed to the MCP transport (see `readJsonBody`'s own
 * comment for why there is no streaming body parser here to delegate to).
 * Without a cap, a single slow POST with an oversized body is an unbounded
 * allocation on a server that `CLICKUP_HTTP_HOST` exists precisely to allow
 * hosting beyond loopback. 5 MiB comfortably covers any realistic MCP
 * tool-call payload this server's own tools accept.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024

/** Thrown by `readJsonBody` when the body exceeds `MAX_BODY_BYTES`; the caller turns this into a 413. */
class PayloadTooLargeError extends Error {}

/**
 * Reads and JSON-parses the request body. `StreamableHTTPServerTransport.handleRequest`
 * takes an optional pre-parsed body (its own doc comment calls this out as
 * "pre-parsed body from body-parser middleware") - this server has no body
 * parser dependency, so it reads the body itself rather than adding one.
 * Throws `PayloadTooLargeError` once accumulated bytes exceed
 * `MAX_BODY_BYTES` (checked per chunk, so this never buffers more than one
 * chunk past the cap), or a `SyntaxError` from `JSON.parse` on malformed
 * JSON; the caller turns the former into a 413 and the latter into a 400.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    totalBytes += chunk.length
    if (totalBytes > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} bytes.`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? undefined : (JSON.parse(text) as unknown)
}

/**
 * The DNS rebinding defence, and the reason this server is allowed to bind
 * locally at all: a browser-originated request always carries an `Origin`
 * header that the page making it cannot spoof, so validating it here closes
 * off a malicious web page silently talking to a server bound on
 * `localhost`. A missing `Origin` is allowed - local, non-browser MCP
 * clients (curl, another local process) never send one - but a present
 * `Origin` must be in the configured allowlist. This check is the FIRST
 * thing `handleMcpRequest` does: before reading the body, before resolving
 * credentials, before any ClickUp call.
 */
function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  return origin === undefined || allowedOrigins.includes(origin)
}

/**
 * Strips a leading `Bearer ` (case-insensitive) from an `Authorization`
 * header value. ClickUp's own API expects the raw personal token, not an
 * OAuth-style bearer scheme, but real MCP clients commonly send
 * `Authorization: Bearer <token>` regardless - without this, `Bearer ` would
 * travel to ClickUp as part of the token and fail as an opaque 401 with no
 * hint of why. A value with no such prefix passes through unchanged.
 */
function stripBearerPrefix(value: string): string {
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match?.[1] ?? value
}

/**
 * The token for one request: the `Authorization` header when present,
 * otherwise `CLICKUP_API_KEY` from the environment. No feature flag decides
 * between the two - this is the whole rule, always applied. `undefined`
 * means neither supplied a token, which `handleMcpRequest` turns into a 401
 * naming the `Authorization` header.
 */
function resolveToken(req: IncomingMessage, config: ServerConfig): string | undefined {
  const header = firstHeaderValue(req.headers.authorization)
  if (header !== undefined && header.length > 0) {
    return stripBearerPrefix(header)
  }
  return config.apiKey.length > 0 ? config.apiKey : undefined
}

function resolveTeamId(req: IncomingMessage, config: ServerConfig): string {
  return firstHeaderValue(req.headers['x-clickup-team-id']) ?? config.teamId
}

/**
 * Handles one `POST /mcp` request end to end: origin check, credential
 * resolution, body parsing, then a fresh `McpServer` and
 * `StreamableHTTPServerTransport` for this request alone (stateless JSON
 * mode - no session id, no cross-request state on the transport side).
 * `TenantStore.contextFor` is what actually isolates tenants; this function
 * only resolves which token and team id apply to this one request.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  tenants: TenantStore,
): Promise<void> {
  const origin = firstHeaderValue(req.headers.origin)
  if (!isOriginAllowed(origin, config.allowedOrigins)) {
    sendJson(res, 403, { error: 'Origin not allowed' })
    return
  }

  const token = resolveToken(req, config)
  if (token === undefined) {
    sendRpcError(res, 401, 'No ClickUp credentials: pass an Authorization header, or set CLICKUP_API_KEY.')
    return
  }

  const teamId = resolveTeamId(req, config)

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendRpcError(res, 413, 'Request body too large.')
    } else {
      sendRpcError(res, 400, 'Malformed JSON request body.')
    }
    return
  }

  const ctx = tenants.contextFor(token, teamId)
  const mcpServer = buildServer({ tools: ALL_TOOLS, config, contextFactory: () => ctx })
  // `sessionIdGenerator` is deliberately omitted rather than set to
  // `undefined` explicitly: the SDK only ever reads the property (see
  // WebStandardStreamableHTTPServerTransport's constructor), so the two are
  // runtime-identical, and omitting it is what satisfies this project's
  // `exactOptionalPropertyTypes: true` against the SDK's own (looser)
  // option type. This is stateless mode either way - no session id means no
  // session bookkeeping, matching the doc comment's own stateless example.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })

  // A fresh server and transport per request, closed once the response ends
  // (whether it completed normally or the connection dropped) - stateless
  // mode keeps no state on either that would need to survive past this.
  res.on('close', () => {
    void transport.close()
    void mcpServer.close()
  })

  try {
    // `StreamableHTTPServerTransport` itself does not structurally satisfy
    // `Transport` under `exactOptionalPropertyTypes: true` (its `onclose`/
    // `onerror`/`onmessage` setters accept `| undefined` explicitly, which
    // is stricter than `Transport`'s own optional-property types allow) -
    // an SDK typing friction under this flag, not a runtime concern; `connect`
    // only ever reads/writes those same setters at runtime.
    await mcpServer.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res, body)
  } catch {
    failRequest(res, 500, 'Internal server error.')
  }
}

/**
 * Builds the stateless Streamable HTTP MCP server: a single route,
 * `POST /mcp`, everything else 404 - checked before origin validation,
 * credential resolution or anything else, since a 404 carries no
 * request-derived information to protect. Does not bind a socket itself;
 * the caller decides when (and to which address) to `listen`.
 */
export function createHttpServer(config: ServerConfig): Server {
  const tenants = new TenantStore(config)

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'POST' || url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    void handleMcpRequest(req, res, config, tenants)
  })
}

/**
 * The HTTP transport's startup readiness line, gated by `LOG_LEVEL` (Task
 * 19 follow-up to Task 18): `info` level, so `LOG_LEVEL=warn` or `error`
 * suppresses it while the default `info` and `debug` both keep it. Exported
 * so its gating can be tested directly rather than only by inspection.
 */
export function logReadiness(config: ServerConfig): void {
  logStderr(
    config.logLevel,
    'info',
    `clickup-mcp-http ready: listening on ${config.httpHost}:${config.httpPort}, mode=${config.mode}`,
  )
}

// Only binds a socket when this module is run directly as the
// `clickup-mcp-http` entry point - never as a side effect of importing
// `createHttpServer` from a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(process.env)
  const httpServer = createHttpServer(config)
  httpServer.listen(config.httpPort, config.httpHost, () => {
    // Binding anywhere other than the loopback default is an explicit
    // choice (CLICKUP_HTTP_HOST), and the address it actually bound to is
    // named here on stderr so that choice is never silent - subject to the
    // same LOG_LEVEL gate as every other startup line.
    logReadiness(config)
  })
}
