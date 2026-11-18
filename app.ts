// The forge's HTTP surface: git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL at /api/graphql and MCP at /mcp, over one shared store. Every REST reply is JSON with
// an X-GitHub-Request-Id; a request with no bearer token is 401 on the API surfaces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type HttpResult } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphql } from './graphql.ts';
import {
  handleReceivePack, handleUploadPackV0, handleUploadPackV2, v0Advertisement, v2Advertisement,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `makefun-forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.toLowerCase().startsWith('bearer ') && header.slice(7).trim() !== '';
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(forge, req, res);
      } catch (caught) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: `internal error: ${caught instanceof Error ? caught.message : String(caught)}` });
        } else {
          res.end();
        }
      }
    })();
  });
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const sub = gitMatch[3] ?? '';
    const repo = forge.getRepo(owner, name);
    if (sub === '/info/refs' && method === 'GET') {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const service = url.searchParams.get('service') ?? '';
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (service === 'git-upload-pack' && version2) {
        sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-upload-pack' || service === 'git-receive-pack') {
        sendRaw(res, 200, v0Advertisement(service, forge, repo), `application/x-${service}-advertisement`);
        return;
      }
      sendJson(res, 403, { message: 'unsupported service' });
      return;
    }
    if (sub === '/git-upload-pack' && method === 'POST') {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const out = version2 ? handleUploadPackV2(forge, repo, body) : handleUploadPackV0(forge, repo, body);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    if (sub === '/git-receive-pack' && method === 'POST') {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      const out = await handleReceivePack(forge, repo, body);
      sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- MCP
  if (path === '/mcp') {
    if (method === 'POST') {
      const body = await readBody(req);
      const result = handleMcp(forge, body, authorized(req));
      if (result.body === null) {
        res.writeHead(result.status, { 'content-type': JSON_TYPE });
        res.end();
        return;
      }
      sendJson(res, result.status, result.body, result.headers);
      return;
    }
    if (method === 'GET' || method === 'DELETE') {
      // No server-initiated stream is offered; the transport allows a plain 405 here.
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'method not allowed' } });
      return;
    }
  }

  // ---- GraphQL
  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const result = handleGraphql(forge, parsed);
    sendJson(res, result.status, result.body);
    return;
  }

  // ---- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let body: unknown;
    const raw = await readBody(req);
    if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const subPath = path.slice('/api/v3'.length);
    const result: HttpResult = handleRest({
      forge, method, path: subPath, query: url.searchParams, body, rawBody: raw, host,
    });
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
