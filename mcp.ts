// MCP over Streamable HTTP (JSON-RPC 2.0), speaking the 2026-07-28 revision via server/discover
// and the classic initialize handshake for 2025-11-25 and earlier. The tools act on the same
// store as REST, so an object created over MCP reads back over /api/v3 unchanged.

import { Forge, VIEWER, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { commitOnBranch, tipTree } from './rest.ts';
import { upsertPath, EMPTY_TREE_SHA } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown; // null means an empty reply (notifications)
  headers?: Record<string, string>;
}

interface Tool {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}
function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : (typeof args.name === 'string' ? args.name : '');
  const repo = forge.getRepo(owner, name);
  if (!repo) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (forge, args) => {
      const name = String(args.name);
      if (forge.getRepo(VIEWER.login, name)) throw new Error('name already exists on this account');
      const repo = forge.createRepo(name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : null,
      });
      return textResult(repoJson(repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => textResult(repoJson(needRepo(forge, args))),
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    properties: {},
    required: [],
    run: (forge) => textResult(forge.listRepos().map(repoJson)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const number = repo.nextNumber++;
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const issue = {
        number, title: String(args.title), body: typeof args.body === 'string' ? args.body : null,
        state: 'open' as const, labels: [] as string[], comments: [], created_at: stamp, updated_at: stamp, isPull: false as const,
      };
      repo.issues.set(number, issue);
      return textResult(issueJson(repo, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      return textResult(issues.map((i) => issueJson(repo, i)));
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) throw new Error('issue not found');
      return textResult(issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = forge.resolveRef(repo, `refs/heads/${head}`);
      const baseSha = forge.resolveRef(repo, `refs/heads/${base}`);
      if (!headSha) throw new Error(`head branch "${head}" does not exist`);
      if (!baseSha) throw new Error(`base branch "${base}" does not exist`);
      const number = repo.nextNumber++;
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pull = {
        number, title: String(args.title), body: typeof args.body === 'string' ? args.body : null,
        state: 'open' as const, merged: false, merged_at: null, merge_commit_sha: null,
        headRef: head, headSha, baseRef: base, created_at: stamp, updated_at: stamp, isPull: true as const,
      };
      repo.pulls.set(number, pull);
      return textResult(pullJson(forge, repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) throw new Error('pull request not found');
      if (pull.state !== 'open') throw new Error('pull request is not open');
      // Squash: the base branch takes the head tree in one commit.
      const headTree = tipTree(forge, repo, pull.headRef);
      const sha = commitOnBranch(forge, repo, pull.baseRef, headTree === EMPTY_TREE_SHA ? headTree : headTree, `${pull.title} (#${pull.number})`);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      pull.merge_commit_sha = sha;
      return textResult({ sha, merged: true, message: 'Pull Request successfully merged' });
    },
  },
  {
    name: 'create_file',
    description: 'Create or update a file in a repository on its default branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      path: { type: 'string', description: 'The file path.' },
      content: { type: 'string', description: 'The file content (UTF-8 text).' },
      message: { type: 'string', description: 'The commit message.' },
    },
    required: ['owner', 'repo', 'path', 'content'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const path = String(args.path);
      const tree = tipTree(forge, repo, repo.defaultBranch);
      const blobSha = forge.objects.put('blob', Buffer.from(String(args.content), 'utf8'));
      const newTree = upsertPath(forge.objects, tree === EMPTY_TREE_SHA ? undefined : tree, path, { mode: '100644', sha: blobSha });
      const sha = commitOnBranch(forge, repo, repo.defaultBranch, newTree, typeof args.message === 'string' ? args.message : `Update ${path}`);
      return textResult({ commit: { sha }, content: { path, sha: blobSha } });
    },
  },
];

const TOOLS_LIST_BODY = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function handleMcp(forge: Forge, rawBody: Buffer, authorized: boolean): McpResult {
  if (!authorized) {
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const answers: unknown[] = [];
  for (const request of requests) {
    const answer = handleOne(forge, request as Record<string, unknown>);
    if (answer !== undefined) answers.push(answer);
  }
  if (answers.length === 0) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(parsed) ? answers : answers[0] };
}

function handleOne(forge: Forge, request: Record<string, unknown>): unknown {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = request.id === undefined;
  const result = (value: unknown): unknown => ({ jsonrpc: '2.0', id, result: value });
  const failure = (code: number, message: string): unknown => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: SUPPORTED_VERSIONS,
        protocolVersion: SUPPORTED_VERSIONS[0],
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    case 'initialize': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
      return result({
        protocolVersion: version,
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return result({});
    case 'tools/list':
      return result(TOOLS_LIST_BODY);
    case 'tools/call': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name) ?? TOOLS.find((t) => name.toLowerCase().endsWith(t.name));
      if (!tool) return failure(-32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // A full_name argument (owner/repo) fills owner and repo when they are absent.
      if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
        const [owner, repo] = args.full_name.split('/', 2);
        if (args.owner === undefined) args.owner = owner;
        if (args.repo === undefined) args.repo = repo;
      }
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return result(errorResult(`missing required argument: ${required}`));
        }
      }
      try {
        return result(tool.run(forge, args));
      } catch (caught) {
        return result(errorResult(caught instanceof Error ? caught.message : String(caught)));
      }
    }
    default:
      if (isNotification) return undefined;
      return failure(-32601, `method not found: ${method}`);
  }
}
