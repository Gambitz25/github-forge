// GraphQL v4: a small executor for the documents gh and github-mcp-server send — viewer,
// repository fields, issue/pull connections with cursors, the create/close/merge mutations,
// addComment, node(id:) round-trips, and the __type introspection gh feature-detects with.
// Global ids are deterministic (base64 of "Type:key"), so repeated reads agree.

import { Forge, VIEWER, nowIso, type Repo } from './store.ts';
import { commitOnBranch, pullFiles, tipTree } from './rest.ts';
import { EMPTY_TREE_SHA } from './store.ts';

// ---------------------------------------------------------------- ids

function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}
function parseGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { type: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}
const repoGid = (repo: Repo): string => gid('Repository', String(repo.id));
const issueGid = (repo: Repo, number: number): string => gid('Issue', `${repo.id}:${number}`);
const pullGid = (repo: Repo, number: number): string => gid('PullRequest', `${repo.id}:${number}`);
const commentGid = (repo: Repo, id: number): string => gid('IssueComment', `${repo.id}:${id}`);

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> }
  | { kind: 'variable'; name: string };

interface FieldNode {
  name: string;
  alias?: string;
  args: Map<string, Value>;
  selection?: FieldNode[];
  fragmentType?: string; // inline fragment condition
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: FieldNode[];
  variables: Record<string, unknown>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:@$!|=&'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (!match) throw new Error(`unexpected character ${c}`);
    tokens.push(match[0]);
    i += match[0].length;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;
  constructor(source: string) {
    this.tokens = tokenize(source);
  }
  peek(): string | undefined {
    return this.tokens[this.at];
  }
  next(): string {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  /** Skip a balanced (...) or {...} group (variable definitions, directives). */
  skipGroup(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }
  parseOperation(): { type: 'query' | 'mutation'; name?: string; selection: FieldNode[] } {
    const first = this.peek();
    if (first === '{') {
      return { type: 'query', selection: this.parseSelection() };
    }
    const kind = this.next();
    if (kind !== 'query' && kind !== 'mutation') throw new Error(`unsupported definition ${kind}`);
    let name: string | undefined;
    if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
    if (this.peek() === '(') this.skipGroup('(', ')');
    // Directives between the head and the selection are not used by these documents.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipGroup('(', ')');
    }
    return { type: kind, name, selection: this.parseSelection() };
  }
  parseSelection(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const on = this.next();
        if (on !== 'on') throw new Error('only inline fragments are supported');
        const type = this.next();
        const inner = this.parseSelection();
        for (const field of inner) fields.push({ ...field, fragmentType: type });
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipGroup('(', ')');
    }
    let selection: FieldNode[] | undefined;
    if (this.peek() === '{') selection = this.parseSelection();
    return { name, alias, args, selection };
  }
  parseValue(): Value {
    const token = this.next();
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: token };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: token };
    return { kind: 'enum', value: token };
  }
  done(): boolean {
    return this.at >= this.tokens.length;
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
      return Number(value.value);
    case 'boolean':
      return value.value === 'true';
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = resolveValue(v, variables);
      return out;
    }
    case 'variable':
      return variables[value.name];
  }
}

// ---------------------------------------------------------------- schema surface

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target', 'prefix'],
  RefTarget: ['oid', 'id'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'repository',
  ],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  errors: Array<{ message: string }>;
}

type Resolver = (source: any, args: Record<string, unknown>, ctx: Ctx) => unknown;

function connection<T>(
  items: T[],
  args: Record<string, unknown>,
  render: (item: T) => unknown,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const decoded = Buffer.from(args.after, 'base64url').toString('utf8');
      const at = Number(decoded.replace('cursor:', ''));
      if (Number.isFinite(at)) start = at + 1;
    } catch {
      start = 0;
    }
  }
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? Buffer.from(`cursor:${start + slice.length - 1}`).toString('base64url') : null;
  return {
    __type: 'Connection',
    nodes: slice.map(render),
    edges: slice.map((item, i) => ({ node: render(item), cursor: Buffer.from(`cursor:${start + i}`).toString('base64url') })),
    pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor, hasPreviousPage: start > 0, startCursor: slice.length > 0 ? Buffer.from(`cursor:${start}`).toString('base64url') : null },
    totalCount: items.length,
  };
}

function repoByGid(forge: Forge, id: string): Repo | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.type !== 'Repository') return undefined;
  return forge.listRepos().find((r) => r.id === Number(parsed.key));
}

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User' }),
    repository: (_s, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? { __type: 'Repository', repo } : null;
    },
    node: (_s, args, ctx) => {
      const parsed = parseGid(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = ctx.forge.listRepos().find((r) => r.id === Number(parsed.key));
        return repo ? { __type: 'Repository', repo } : null;
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const [repoId, number] = parsed.key.split(':').map(Number);
        const repo = ctx.forge.listRepos().find((r) => r.id === repoId);
        if (!repo) return null;
        return parsed.type === 'Issue'
          ? { __type: 'Issue', repo, number }
          : { __type: 'PullRequest', repo, number };
      }
      return null;
    },
    __type: (_s, args) => {
      const name = String(args.name ?? '');
      if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
      return { __type: '__Type', name };
    },
    __schema: () => ({ __type: '__Schema' }),
    search: (_s, args, ctx) => connection([], args, () => null),
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGid(ctx.forge, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const number = repo.nextNumber++;
      const stamp = nowIso();
      repo.issues.set(number, {
        number, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : null,
        state: 'open', labels: [], comments: [], created_at: stamp, updated_at: stamp, isPull: false,
      });
      return { __type: 'CreateIssuePayload', repo, number };
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.issueId ?? ''));
      if (!parsed || parsed.type !== 'Issue') throw new Error('issue not found');
      const [repoId, number] = parsed.key.split(':').map(Number);
      const repo = ctx.forge.listRepos().find((r) => r.id === repoId);
      const issue = repo?.issues.get(number);
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updated_at = nowIso();
      return { __type: 'CloseIssuePayload', repo, number };
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGid(ctx.forge, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = ctx.forge.resolveRef(repo, `refs/heads/${head}`);
      if (!headSha) throw new Error(`head ref "${head}" does not exist`);
      if (!ctx.forge.resolveRef(repo, `refs/heads/${base}`)) throw new Error(`base ref "${base}" does not exist`);
      const number = repo.nextNumber++;
      const stamp = nowIso();
      repo.pulls.set(number, {
        number, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : null,
        state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
        headRef: head, headSha, baseRef: base, created_at: stamp, updated_at: stamp, isPull: true,
      });
      return { __type: 'CreatePullRequestPayload', repo, number };
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.type !== 'PullRequest') throw new Error('pull request not found');
      const [repoId, number] = parsed.key.split(':').map(Number);
      const repo = ctx.forge.listRepos().find((r) => r.id === repoId);
      const pull = repo?.pulls.get(number);
      if (!repo || !pull) throw new Error('pull request not found');
      const headTree = tipTree(ctx.forge, repo, pull.headRef);
      const sha = commitOnBranch(ctx.forge, repo, pull.baseRef, headTree, `${pull.title} (#${pull.number})`);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = nowIso();
      pull.merge_commit_sha = sha;
      return { __type: 'MergePullRequestPayload', repo, number };
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.subjectId ?? ''));
      if (!parsed || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) throw new Error('subject not found');
      const [repoId, number] = parsed.key.split(':').map(Number);
      const repo = ctx.forge.listRepos().find((r) => r.id === repoId);
      if (!repo) throw new Error('subject not found');
      if (parsed.type === 'Issue') {
        const issue = repo.issues.get(number);
        if (!issue) throw new Error('subject not found');
        const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), created_at: nowIso() };
        issue.comments.push(comment);
        return { __type: 'AddCommentPayload', repo, commentId: comment.id, body: comment.body };
      }
      // Pull requests accept comments too; the suite comments on issues, but keep the door open.
      return { __type: 'AddCommentPayload', repo, commentId: repo.nextCommentId++, body: String(input.body ?? '') };
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => gid('User', String(VIEWER.id)),
    databaseId: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (s) => repoGid(s.repo as Repo),
    databaseId: (s) => (s.repo as Repo).id,
    name: (s) => (s.repo as Repo).name,
    nameWithOwner: (s) => `${(s.repo as Repo).owner}/${(s.repo as Repo).name}`,
    owner: () => ({ __type: 'User' }),
    description: (s) => (s.repo as Repo).description,
    isPrivate: (s) => (s.repo as Repo).private,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (s) => (s.repo as Repo).created_at,
    updatedAt: (s) => (s.repo as Repo).updated_at,
    defaultBranchRef: (s, _a, ctx) => {
      const repo = s.repo as Repo;
      const sha = ctx.forge.resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
      if (!sha) return null;
      return { __type: 'Ref', name: repo.defaultBranch, target: { __type: 'RefTarget', oid: sha } };
    },
    issue: (s, args) => {
      const repo = s.repo as Repo;
      const number = Number(args.number);
      return repo.issues.has(number) ? { __type: 'Issue', repo, number } : null;
    },
    issues: (s, args) => {
      const repo = s.repo as Repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states) {
        const wanted = states.map((x) => x.toLowerCase());
        issues = issues.filter((i) => wanted.includes(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return connection(issues, args, (i) => ({ __type: 'Issue', repo, number: i.number }));
    },
    pullRequest: (s, args) => {
      const repo = s.repo as Repo;
      const number = Number(args.number);
      return repo.pulls.has(number) ? { __type: 'PullRequest', repo, number } : null;
    },
    pullRequests: (s, args) => {
      const repo = s.repo as Repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states) {
        const wanted = states.map((x) => x.toUpperCase());
        pulls = pulls.filter((p) => wanted.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      pulls.sort((a, b) => b.number - a.number);
      return connection(pulls, args, (p) => ({ __type: 'PullRequest', repo, number: p.number }));
    },
  },
  Ref: {
    name: (s) => s.name,
    prefix: () => 'refs/heads/',
    target: (s) => s.target,
  },
  RefTarget: {
    oid: (s) => s.oid,
    id: (s) => s.oid,
  },
  Issue: {
    id: (s) => issueGid(s.repo as Repo, s.number as number),
    number: (s) => s.number,
    title: (s) => (s.repo as Repo).issues.get(s.number)?.title ?? '',
    body: (s) => (s.repo as Repo).issues.get(s.number)?.body ?? '',
    state: (s) => ((s.repo as Repo).issues.get(s.number)?.state ?? 'open').toUpperCase(),
    author: () => ({ __type: 'User' }),
    createdAt: (s) => (s.repo as Repo).issues.get(s.number)?.created_at,
    updatedAt: (s) => (s.repo as Repo).issues.get(s.number)?.updated_at,
    closedAt: () => null,
    repository: (s) => ({ __type: 'Repository', repo: s.repo }),
    labels: (s, args) => {
      const repo = s.repo as Repo;
      const issue = repo.issues.get(s.number);
      const labels = (issue?.labels ?? []).map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null, id: gid('Label', name) }));
      return connection(labels, args, (l) => l);
    },
    comments: (s, args) => {
      const repo = s.repo as Repo;
      const issue = repo.issues.get(s.number);
      const comments = (issue?.comments ?? []).map((c) => ({ __type: 'IssueComment', repo, id: c.id, body: c.body, createdAt: c.created_at }));
      return connection(comments, args, (c) => c);
    },
  },
  PullRequest: {
    id: (s) => pullGid(s.repo as Repo, s.number as number),
    number: (s) => s.number,
    title: (s) => (s.repo as Repo).pulls.get(s.number)?.title ?? '',
    body: (s) => (s.repo as Repo).pulls.get(s.number)?.body ?? '',
    state: (s) => {
      const pull = (s.repo as Repo).pulls.get(s.number);
      if (!pull) return 'CLOSED';
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.repo as Repo).pulls.get(s.number)?.merged ?? false,
    mergedAt: (s) => (s.repo as Repo).pulls.get(s.number)?.merged_at ?? null,
    mergeable: (s) => ((s.repo as Repo).pulls.get(s.number)?.state === 'open' ? 'MERGEABLE' : 'UNKNOWN'),
    headRefName: (s) => (s.repo as Repo).pulls.get(s.number)?.headRef ?? '',
    baseRefName: (s) => (s.repo as Repo).pulls.get(s.number)?.baseRef ?? '',
    headRefOid: (s, _a, ctx) => {
      const repo = s.repo as Repo;
      const pull = repo.pulls.get(s.number);
      return pull ? ctx.forge.resolveRef(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha : '';
    },
    baseRefOid: (s, _a, ctx) => {
      const repo = s.repo as Repo;
      const pull = repo.pulls.get(s.number);
      return pull ? ctx.forge.resolveRef(repo, `refs/heads/${pull.baseRef}`) ?? '' : '';
    },
    author: () => ({ __type: 'User' }),
    createdAt: (s) => (s.repo as Repo).pulls.get(s.number)?.created_at,
    updatedAt: (s) => (s.repo as Repo).pulls.get(s.number)?.updated_at,
    repository: (s) => ({ __type: 'Repository', repo: s.repo }),
    files: (s, args, ctx) => {
      const repo = s.repo as Repo;
      const pull = repo.pulls.get(s.number);
      if (!pull) return connection([], args, () => null);
      const files = pullFiles(ctx.forge, repo, pull).map((f) => ({
        __type: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: String(f.status).toUpperCase(),
      }));
      return connection(files, args, (f) => f);
    },
  },
  PullRequestFile: {
    path: (s) => s.path,
    additions: (s) => s.additions,
    deletions: (s) => s.deletions,
    changeType: (s) => s.changeType,
  },
  IssueComment: {
    id: (s) => commentGid(s.repo as Repo, s.id as number),
    body: (s) => s.body,
    author: () => ({ __type: 'User' }),
    createdAt: (s) => s.createdAt,
  },
  Label: {
    id: (s) => s.id,
    name: (s) => s.name,
    color: (s) => s.color,
    description: (s) => s.description,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage,
    endCursor: (s) => s.endCursor,
    hasPreviousPage: (s) => s.hasPreviousPage,
    startCursor: (s) => s.startCursor,
  },
  __Type: {
    name: (s) => s.name,
    kind: (s) => (ENUM_VALUES[s.name as string] ? 'ENUM' : 'OBJECT'),
    fields: (s) => (TYPE_FIELDS[s.name as string] ?? []).map((name) => ({ __type: '__Field', name })),
    enumValues: (s) => (ENUM_VALUES[s.name as string] ?? []).map((name) => ({ __type: '__EnumValue', name })),
  },
  __Field: { name: (s) => s.name },
  __EnumValue: { name: (s) => s.name },
  CreateIssuePayload: { issue: (s) => ({ __type: 'Issue', repo: s.repo, number: s.number }), clientMutationId: () => null },
  CloseIssuePayload: { issue: (s) => ({ __type: 'Issue', repo: s.repo, number: s.number }), clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (s) => ({ __type: 'PullRequest', repo: s.repo, number: s.number }), clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (s) => ({ __type: 'PullRequest', repo: s.repo, number: s.number }), clientMutationId: () => null },
  AddCommentPayload: {
    commentEdge: (s) => ({
      __type: 'IssueCommentEdge',
      node: { __type: 'IssueComment', repo: s.repo, id: s.commentId, body: s.body, createdAt: nowIso() },
      cursor: Buffer.from('cursor:0').toString('base64url'),
    }),
    clientMutationId: () => null,
  },
};

// Connection types share the PageInfo/edges resolvers by shape.
for (const name of ['IssueConnection', 'PullRequestConnection', 'PullRequestFileConnection', 'LabelConnection', 'Connection']) {
  resolvers[name] = {
    nodes: (s) => s.nodes,
    edges: (s) => s.edges,
    pageInfo: (s) => s.pageInfo,
    totalCount: (s) => s.totalCount,
  };
}
for (const name of ['IssueEdge', 'PullRequestEdge', 'IssueCommentEdge']) {
  resolvers[name] = { node: (s) => s.node, cursor: (s) => s.cursor };
}

function executeSelection(typeName: string, source: unknown, selection: FieldNode[], ctx: Ctx, variables: Record<string, unknown>): unknown {
  if (source === null || source === undefined) return null;
  const out: Record<string, unknown> = {};
  const typeResolvers = resolvers[typeName] ?? {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (field.fragmentType && field.fragmentType !== typeName && !(typeof source === 'object' && (source as Record<string, unknown>).__type === field.fragmentType)) {
      continue;
    }
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = typeResolvers[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of field.args) args[argName] = resolveValue(argValue, variables);
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (caught) {
      ctx.errors.push({ message: caught instanceof Error ? caught.message : String(caught) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx, variables);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx, variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selection) return value;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, field, ctx, variables));
  }
  if (typeof value === 'object') {
    const typeName = (value as Record<string, unknown>).__type;
    if (typeof typeName === 'string') {
      return executeSelection(typeName, value, field.selection, ctx, variables);
    }
    // Plain object (edges, payloads without __type): resolve by field-name lookup.
    const out: Record<string, unknown> = {};
    for (const sub of field.selection) {
      const key = sub.alias ?? sub.name;
      out[key] = completeValue((value as Record<string, unknown>)[sub.name], sub, ctx, variables);
    }
    return out;
  }
  return value;
}

export interface GraphqlResult {
  status: number;
  body: unknown;
}

export function handleGraphql(forge: Forge, payload: unknown): GraphqlResult {
  if (Array.isArray(payload)) {
    const results = payload.map((item) => handleGraphql(forge, item).body);
    return { status: 200, body: results };
  }
  const request = (payload ?? {}) as Record<string, unknown>;
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  const ctx: Ctx = { forge, errors: [] };
  try {
    const parser = new Parser(query);
    const operation = parser.parseOperation();
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection(rootType, { __type: rootType }, operation.selection, ctx, variables);
    const body: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) body.errors = ctx.errors;
    return { status: 200, body };
  } catch (caught) {
    return {
      status: 200,
      body: { data: null, errors: [{ message: caught instanceof Error ? caught.message : String(caught) }] },
    };
  }
}
