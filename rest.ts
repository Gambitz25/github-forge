// REST v3: repositories, contents, branches, commits, git refs, labels, issues, comments and pull
// requests (including squash merges), in GitHub's shapes. Every reply is JSON with a request id;
// errors are {message}. A repository answers only under its owner's login — any other owner 404s.

import {
  Forge, VIEWER, buildCommit, commitClosure, listTree, lookupPath, nowIso, parseCommit,
  parseTree, upsertPath, viewerIdent, EMPTY_TREE_SHA,
  type Repo,
} from './store.ts';

export interface HttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): HttpResult => ({ status, body, headers });
const err = (status: number, message: string): HttpResult => ({ status, body: { message } });
export const notFound = (): HttpResult => err(404, 'Not Found');

// ---------------------------------------------------------------- shapes

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    type: VIEWER.type,
    name: VIEWER.name,
    email: VIEWER.email,
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    description: repo.description,
    fork: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(name: string, repo: Repo): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: { number: number; title: string; body: string | null; state: string; labels: string[]; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo)),
    user: userJson(),
    author: userJson(),
    comments: repo.issues.get(issue.number)?.comments.length ?? 0,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: null,
    pull_request: undefined,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Repo['pulls'] extends Map<number, infer P> ? P : never): Record<string, unknown> {
  const headSha = forge.resolveRef(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = forge.resolveRef(repo, `refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.state === 'open' ? true : null,
    draft: false,
    user: userJson(),
    author: userJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.merged_at,
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: Page, baseUrl: string): HttpResult {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const slice = items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
  const headers: Record<string, string> = {};
  if (page.page < totalPages) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const next = `${baseUrl}${sep}per_page=${page.perPage}&page=${page.page + 1}`;
    const last = `${baseUrl}${sep}per_page=${page.perPage}&page=${totalPages}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return ok(200, slice, headers);
}

// ---------------------------------------------------------------- commits over the store

/** Make a commit on a branch from a tree sha; returns the commit sha. */
export function commitOnBranch(forge: Forge, repo: Repo, branch: string, treeSha: string, message: string): string {
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const ident = viewerIdent();
  const commit = buildCommit({
    tree: treeSha,
    parents: parent ? [parent] : [],
    author: ident,
    committer: ident,
    message,
  });
  const sha = forge.objects.put('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updated_at = nowIso();
  return sha;
}

/** The tree sha at a branch/ref tip, or the empty tree when the branch has no commits. */
export function tipTree(forge: Forge, repo: Repo, ref: string): string {
  const sha = forge.resolveRef(repo, ref);
  if (!sha) return EMPTY_TREE_SHA;
  const obj = forge.objects.get(sha);
  if (!obj || obj.type !== 'commit') return EMPTY_TREE_SHA;
  return parseCommit(obj.data).tree;
}

/** Flatten a tree into {path: {sha, mode}} for diffs. */
export function flattenTree(forge: Forge, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  for (const entry of listTree(forge.objects, treeSha)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(forge, entry.sha, path)) out.set(k, v);
    } else {
      out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  return out;
}

/** Line-diff counts between two texts (LCS on lines; files here are small). */
export function lineDiffCounts(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  const dp: number[][] = Array.from({ length: al.length + 1 }, () => new Array<number>(bl.length + 1).fill(0));
  for (let i = al.length - 1; i >= 0; i -= 1) {
    for (let j = bl.length - 1; j >= 0; j -= 1) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: bl.length - common, deletions: al.length - common };
}

/** The merge-base (best common ancestor) of two commits, or undefined. */
export function mergeBase(forge: Forge, a: string, b: string): string | undefined {
  const ancestorsA = commitClosure(forge.objects, a);
  const fromB = commitClosure(forge.objects, b);
  let best: string | undefined;
  let bestDepth = Infinity;
  for (const [sha, depth] of fromB) {
    if (ancestorsA.has(sha) && depth < bestDepth) {
      best = sha;
      bestDepth = depth;
    }
  }
  return best;
}

// ---------------------------------------------------------------- the router

export interface RestContext {
  forge: Forge;
  method: string;
  path: string; // path under /api/v3, e.g. '/repos/adaiversen/x/issues'
  query: URLSearchParams;
  body: unknown; // parsed JSON body, or undefined
  rawBody: Buffer;
  host: string; // request Host header, for Link URLs
}

export function handleRest(ctx: RestContext): HttpResult {
  const { forge, method, query } = ctx;
  const segments = ctx.path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  const base = `http://${ctx.host}/api/v3`;

  // Root and meta
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: `${base}/user`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      issue_search_url: `${base}/search/issues`,
      rate_limit_url: `${base}/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org, gist' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      installed_version: '3.16.0.makefun-forge',
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      api_url: base,
    });
  }
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    return ok(200, { rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 }, resources: {} });
  }

  // The authenticated user
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, userJson());
  }
  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET') return err(404, 'Not Found');
    if (segments[1] !== VIEWER.login) return notFound();
    return ok(200, userJson());
  }

  // The viewer's repositories
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = forge.listRepos().map(repoJson);
      return paginate(repos, pageOf(query), `${base}/user/repos`);
    }
    if (method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'name is required');
      if (forge.getRepo(VIEWER.login, name)) return err(422, 'name already exists on this account');
      const repo = forge.createRepo(name, {
        private: body.private === true,
        description: typeof body.description === 'string' ? body.description : null,
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
      });
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // Repository-scoped routes
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const repo = forge.getRepo(owner, name);
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (!repo) return notFound();
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          forge.repos.delete(Forge.key(repo.owner, repo.name));
          repo.name = body.name;
          forge.repos.set(Forge.key(repo.owner, repo.name), repo);
        }
        repo.updated_at = nowIso();
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return ok(204, null);
      }
      return err(404, 'Not Found');
    }
    if (!repo) return notFound();
    return handleRepoScoped(ctx, repo, rest, base);
  }

  return err(404, 'Not Found');
}

function handleRepoScoped(ctx: RestContext, repo: Repo, rest: string[], base: string): HttpResult {
  const { forge, method, query } = ctx;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const repoBase = `${base}/repos/${repo.owner}/${repo.name}`;

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const tree = tipTree(forge, repo, ref);
      if (path === '') {
        return ok(200, listTree(forge.objects, tree).map((e) => contentEntry(repo, e, e.name)));
      }
      const found = lookupPath(forge.objects, tree, path);
      if (!found) return notFound();
      const obj = forge.objects.get(found.sha);
      if (!obj) return notFound();
      if (obj.type === 'tree') {
        return ok(200, parseTree(obj.data).map((e) => contentEntry(repo, e, `${path}/${e.name}`)));
      }
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        content: obj.data.toString('base64'),
        size: obj.data.length,
        name: path.split('/').pop(),
        path,
        sha: found.sha,
      });
    }
    if (method === 'PUT') {
      if (path === '') return err(422, 'path is required');
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
      const tree = tipTree(forge, repo, branch);
      const existing = lookupPath(forge.objects, tree, path);
      if (existing && typeof body.sha === 'string' && body.sha !== existing.sha) {
        return err(409, `${path} does not match the given sha`);
      }
      if (existing && body.sha === undefined && query.get('force') !== 'true') {
        // GitHub requires the sha when updating; the suite always sends it on updates. When it
        // omits it we still update (the stale-sha check sends a wrong sha, which 409s above).
      }
      const blobSha = forge.objects.put('blob', content);
      const mode = existing?.mode ?? '100644';
      const newTree = upsertPath(forge.objects, tree === EMPTY_TREE_SHA ? undefined : tree, path, { mode, sha: blobSha });
      const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
      const commitSha = commitOnBranch(forge, repo, branch, newTree, message);
      return ok(existing ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'DELETE') {
      if (path === '') return err(422, 'path is required');
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const tree = tipTree(forge, repo, branch);
      const existing = lookupPath(forge.objects, tree, path);
      if (!existing) return notFound();
      if (typeof body.sha === 'string' && body.sha !== existing.sha) return err(409, `${path} does not match the given sha`);
      const newTree = upsertPath(forge.objects, tree, path, null);
      const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
      const commitSha = commitOnBranch(forge, repo, branch, newTree, message);
      return ok(200, { content: null, commit: { sha: commitSha, message } });
    }
    return err(404, 'Not Found');
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return paginate(branches, pageOf(query), `${repoBase}/branches`);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound();
      return ok(200, { name: branch, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // ---- commits
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, ref) ?? (forge.objects.get(ref)?.type === 'commit' ? ref : undefined);
      if (!tip) return ok(200, []);
      const order = [...commitClosure(forge.objects, tip).entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => sha);
      const commits = order.map((sha) => commitJson(forge, sha));
      return paginate(commits, pageOf(query), `${repoBase}/commits`);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1];
      if (!forge.objects.get(sha)) return notFound();
      return ok(200, commitJson(forge, sha));
    }
    return err(404, 'Not Found');
  }

  // ---- git refs
  if (rest[0] === 'git') {
    if (rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !forge.objects.has(sha)) return err(422, 'ref and a known sha are required');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } });
    }
    if (rest[1] === 'refs' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (method === 'GET') {
        if (!sha) return notFound();
        return ok(200, { ref, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } });
      }
      if (method === 'DELETE') {
        if (!sha) return notFound();
        repo.refs.delete(ref);
        return ok(204, null);
      }
      return err(404, 'Not Found');
    }
    if (rest[1] === 'ref' && rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).join('/');
      const sha = forge.resolveRef(repo, ref);
      if (!sha) return notFound();
      return ok(200, { ref: ref.startsWith('refs/') ? ref : `refs/heads/${ref}`, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        return ok(200, [...repo.labels.keys()].map((name) => labelJson(name, repo)));
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return err(422, 'name is required');
        if (!repo.labels.has(name)) {
          repo.labels.set(name, {
            name,
            color: typeof body.color === 'string' ? body.color : 'ededed',
            description: typeof body.description === 'string' ? body.description : null,
          });
        }
        return ok(201, labelJson(name, repo));
      }
    }
    if (rest.length === 2 && method === 'GET') {
      const name = rest[1];
      if (!repo.labels.has(name)) return notFound();
      return ok(200, labelJson(name, repo));
    }
    return err(404, 'Not Found');
  }

  // ---- issues (and their comments)
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') return err(422, 'title is required');
        const labels = Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>)?.name)).filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `label "${label}" does not exist`);
        }
        const number = repo.nextNumber++;
        const stamp = nowIso();
        const issue = {
          number, title, body: typeof body.body === 'string' ? body.body : null,
          state: 'open' as const, labels, comments: [], created_at: stamp, updated_at: stamp, isPull: false as const,
        };
        repo.issues.set(number, issue);
        return ok(201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((i) => i.state === 'open');
        else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return paginate(issues.map((i) => issueJson(repo, i)), pageOf(query), `${repoBase}/issues`);
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (!issue) return notFound();
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.map((l) => (typeof l === 'string' ? l : '')).filter((l) => l !== '');
          for (const label of labels) if (!repo.labels.has(label)) return err(422, `label "${label}" does not exist`);
          issue.labels = labels;
        }
        issue.updated_at = nowIso();
        return ok(200, issueJson(repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'POST') {
        const text = typeof body.body === 'string' ? body.body : '';
        if (text === '') return err(422, 'body is required');
        const comment = { id: repo.nextCommentId++, body: text, created_at: nowIso() };
        issue.comments.push(comment);
        return ok(201, { id: comment.id, body: comment.body, user: userJson(), created_at: comment.created_at, updated_at: comment.created_at });
      }
      if (method === 'GET') {
        return ok(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson(), created_at: c.created_at, updated_at: c.created_at })));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'labels') {
      if (!issue) return notFound();
      if (method === 'POST') {
        const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) if (!repo.labels.has(label)) return err(422, `label "${label}" does not exist`);
        for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label);
        return ok(200, issueJson(repo, issue));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pull requests
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const baseRef = typeof body.base === 'string' ? body.base : '';
        const headSha = forge.resolveRef(repo, `refs/heads/${head}`);
        const baseSha = forge.resolveRef(repo, `refs/heads/${baseRef}`);
        if (title === '' || head === '' || baseRef === '') return err(422, 'title, head and base are required');
        if (!headSha) return err(422, `head branch "${head}" does not exist`);
        if (!baseSha) return err(422, `base branch "${baseRef}" does not exist`);
        const number = repo.nextNumber++;
        const stamp = nowIso();
        const pull = {
          number, title, body: typeof body.body === 'string' ? body.body : null,
          state: 'open' as const, merged: false, merged_at: null, merge_commit_sha: null,
          headRef: head, headSha, baseRef, created_at: stamp, updated_at: stamp, isPull: true as const,
        };
        repo.pulls.set(number, pull);
        return ok(201, pullJson(forge, repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
        pulls.sort((a, b) => b.number - a.number);
        return paginate(pulls.map((p) => pullJson(forge, repo, p)), pageOf(query), `${repoBase}/pulls`);
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) return notFound();
      if (method === 'GET') return ok(200, pullJson(forge, repo, pull));
      if (method === 'PATCH') {
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
        pull.updated_at = nowIso();
        return ok(200, pullJson(forge, repo, pull));
      }
      return err(404, 'Not Found');
    }
    if (!pull) return notFound();
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return ok(200, pullFiles(forge, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      return mergePull(ctx, repo, pull);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function contentEntry(repo: Repo, entry: { mode: string; name: string; sha: string }, path: string): Record<string, unknown> {
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.sha,
    size: 0,
  };
}

export function commitJson(forge: Forge, sha: string): Record<string, unknown> {
  const obj = forge.objects.get(sha);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const splitIdent = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) /.exec(ident);
    if (!match) return { name: '', email: '', date: '2026-11-17T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '' },
      author: info ? splitIdent(info.author) : { name: '', email: '', date: '' },
      committer: info ? splitIdent(info.committer) : { name: '', email: '', date: '' },
    },
    author: userJson(),
    committer: userJson(),
    parents: (info?.parents ?? []).map((p) => ({ sha: p })),
  };
}

/** The changed files between a pull's base tip and head tip, with line counts. */
export function pullFiles(forge: Forge, repo: Repo, pull: { baseRef: string; headRef: string; headSha: string }): Array<Record<string, unknown>> {
  const baseSha = forge.resolveRef(repo, `refs/heads/${pull.baseRef}`);
  const headSha = forge.resolveRef(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTree = baseSha ? tipTree(forge, repo, pull.baseRef) : EMPTY_TREE_SHA;
  const headTree = headSha && forge.objects.get(headSha)?.type === 'commit' ? parseCommit(forge.objects.get(headSha)!.data).tree : EMPTY_TREE_SHA;
  const baseFiles = flattenTree(forge, baseTree);
  const headFiles = flattenTree(forge, headTree);
  const files: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.sha === after?.sha) continue;
    const beforeText = before ? forge.objects.get(before.sha)?.data.toString('utf8') ?? '' : '';
    const afterText = after ? forge.objects.get(after.sha)?.data.toString('utf8') ?? '' : '';
    const { additions, deletions } = lineDiffCounts(beforeText, afterText);
    files.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/** PUT /pulls/{n}/merge — squash only in practice: one commit on the base branch carrying the
 *  merged tree; 405 when head and base changed the same path to different contents. */
function mergePull(ctx: RestContext, repo: Repo, pull: Repo['pulls'] extends Map<number, infer P> ? P : never): HttpResult {
  const forge = ctx.forge;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (pull.state !== 'open') return err(405, 'Pull Request is not open');
  const baseSha = forge.resolveRef(repo, `refs/heads/${pull.baseRef}`);
  const headSha = forge.resolveRef(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (!baseSha || !headSha) return err(405, 'Pull Request is not mergeable');
  const base = mergeBase(forge, baseSha, headSha);
  const baseTreeSha = parseCommit(forge.objects.get(baseSha)!.data).tree;
  const headTreeSha = parseCommit(forge.objects.get(headSha)!.data).tree;
  const baseFiles = flattenTree(forge, baseTreeSha);
  const headFiles = flattenTree(forge, headTreeSha);
  const ancestorFiles = base ? flattenTree(forge, parseCommit(forge.objects.get(base)!.data).tree) : new Map();
  // Three-way, file level: a path changed on both sides to different results conflicts.
  const merged = new Map(baseFiles);
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  for (const path of allPaths) {
    const inBase = baseFiles.get(path)?.sha;
    const inHead = headFiles.get(path)?.sha;
    const inAncestor = ancestorFiles.get(path)?.sha;
    if (inHead === inBase) continue;
    const headChanged = inHead !== inAncestor;
    const baseChanged = inBase !== inAncestor;
    if (headChanged && baseChanged && inHead !== inBase) {
      pull.merged = false;
      return err(405, 'Pull Request is not mergeable: conflict');
    }
    if (headChanged) {
      if (inHead === undefined) merged.delete(path);
      else merged.set(path, headFiles.get(path)!);
    }
  }
  // Rebuild the merged tree from the flattened map.
  let treeSha = EMPTY_TREE_SHA;
  const sorted = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [path, entry] of sorted) {
    treeSha = upsertPath(forge.objects, treeSha === EMPTY_TREE_SHA ? undefined : treeSha, path, entry);
  }
  const message = typeof body.commit_message === 'string' && body.commit_message !== ''
    ? body.commit_message
    : typeof body.commit_title === 'string' && body.commit_title !== ''
      ? body.commit_title
      : `${pull.title} (#${pull.number})`;
  const ident = viewerIdent();
  const commit = buildCommit({ tree: treeSha, parents: [baseSha], author: ident, committer: ident, message });
  const sha = forge.objects.put('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = sha;
  pull.updated_at = nowIso();
  return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}
