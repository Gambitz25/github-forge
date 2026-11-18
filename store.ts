// The forge's store: a content-addressed git object store shared by every repository, plus the
// repository records (refs, issues, pull requests, labels) that REST, GraphQL, MCP and the git
// protocol all read and write. Everything is in memory; a trial starts empty and the suite builds
// its data through the surfaces themselves.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_SHA = '0'.repeat(40);

/** The one identity the trial's token names (the suite's seeded viewer, wire.ts buildScenario()). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** Deterministic clock: MAKEFUN_TRIAL_NOW when the env sets it, else a fixed base; each stamp
 *  advances one second so created_at values order the way the suite creates them, identically on
 *  a replayed run. */
const BASE_TIME_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return Date.parse('2026-11-17T00:00:00Z');
})();
let tick = 0;
export function nowDate(): Date {
  tick += 1;
  return new Date(BASE_TIME_MS + tick * 1000);
}
export function nowIso(): string {
  return nowDate().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
/** Git timestamps (seconds) from the same deterministic clock. */
export function nowGitTs(): number {
  return Math.floor(nowDate().getTime() / 1000);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object store: sha -> object, for every repository at once (objects are content-addressed). */
export class ObjectStore {
  private objects = new Map<string, GitObject>();

  put(type: ObjectType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const sha = sha1Hex(Buffer.concat([header, data]));
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  /** Store an object whose sha is already known (from a received pack), verifying its content. */
  putVerified(sha: string, type: ObjectType, data: Buffer): boolean {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    if (sha1Hex(Buffer.concat([header, data])) !== sha) return false;
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return true;
  }
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  sha: string;
}

/** Parse a tree object's body into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (git sorts by name, directories as if suffixed with '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** "Name <email> ts +0000" for the viewer at the deterministic clock. */
export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${nowGitTs()} +0000`;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string; created_at: string }>;
  created_at: string;
  updated_at: string;
  isPull: false;
}

export interface PullRecord {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string; // branch name in this repository
  headSha: string;
  baseRef: string;
  created_at: string;
  updated_at: string;
  isPull: true;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>; // full ref name -> sha ('refs/heads/main', 'refs/tags/v1', 'HEAD' handled apart)
  headBranch: string; // the branch HEAD points at
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  labels: Map<string, { name: string; color: string; description: string | null }>;
  nextNumber: number; // issues and pulls share one sequence, as on GitHub
  nextCommentId: number;
}

let nextRepoId = 1;

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, init: { private?: boolean; description?: string | null; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: nextRepoId++,
      name,
      owner: VIEWER.login,
      private: init.private ?? false,
      description: init.description ?? null,
      defaultBranch: init.defaultBranch && init.defaultBranch !== '' ? init.defaultBranch : 'main',
      created_at: nowIso(),
      updated_at: nowIso(),
      refs: new Map(),
      headBranch: '',
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    repo.headBranch = repo.defaultBranch;
    this.repos.set(Forge.key(repo.owner, name), repo);
    return repo;
  }

  /** A repository is visible only under its owner's login: any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(Forge.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(Forge.key(owner, name));
  }

  /** The sha a branch name or full ref resolves to in a repo, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') {
      const target = repo.refs.get(`refs/heads/${repo.headBranch}`);
      return target;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  /** All refs as [fullName, sha], HEAD's target first is the caller's concern. */
  allRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
}

/** Walk commits from `start` (inclusive) following parents; returns shas in visit order. */
export function commitClosure(store: ObjectStore, start: string, maxDepth?: number): Map<string, number> {
  const seen = new Map<string, number>();
  const queue: Array<{ sha: string; depth: number }> = [{ sha: start, depth: 0 }];
  while (queue.length > 0) {
    const { sha, depth } = queue.shift()!;
    if (seen.has(sha)) continue;
    const obj = store.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    seen.set(sha, depth);
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    const info = parseCommit(obj.data);
    for (const parent of info.parents) queue.push({ sha: parent, depth: depth + 1 });
  }
  return seen;
}

/** Every object reachable from a commit: the commit, its trees and blobs, recursively. */
export function reachableObjects(store: ObjectStore, commitSha: string, into: Set<string>): void {
  const commit = store.get(commitSha);
  if (!commit) return;
  if (commit.type === 'tag') {
    into.add(commitSha);
    const match = /^object ([0-9a-f]{40})$/m.exec(commit.data.toString('utf8'));
    if (match) reachableObjects(store, match[1], into);
    return;
  }
  if (commit.type !== 'commit') {
    into.add(commitSha);
    return;
  }
  into.add(commitSha);
  const info = parseCommit(commit.data);
  const walkTree = (treeSha: string): void => {
    if (into.has(treeSha)) return;
    const tree = store.get(treeSha);
    if (!tree || tree.type !== 'tree') return;
    into.add(treeSha);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') walkTree(entry.sha);
      else into.add(entry.sha);
    }
  };
  walkTree(info.tree);
}

/** Read a file's blob sha at a path inside a tree, or undefined. */
export function lookupPath(store: ObjectStore, treeSha: string, path: string): { sha: string; mode: string } | undefined {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = store.get(current);
    if (!tree || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return { sha: entry.sha, mode: entry.mode };
    if (entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return undefined;
}

/** List a directory of a tree: entries with their modes and shas. */
export function listTree(store: ObjectStore, treeSha: string): TreeEntry[] {
  const tree = store.get(treeSha);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data);
}

/**
 * Return a new tree sha with `path` set to (mode, blobSha), or removed when blobSha is null,
 * creating intermediate trees as needed. `treeSha` may be the empty-tree sha or undefined for empty.
 */
export function upsertPath(store: ObjectStore, treeSha: string | undefined, path: string, blob: { mode: string; sha: string } | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  const build = (current: string | undefined, depth: number): string => {
    const entries: TreeEntry[] = current ? listTree(store, current) : [];
    const name = parts[depth];
    const at = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blob === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) entries[at] = { mode: blob.mode, name, sha: blob.sha };
      else entries.push({ mode: blob.mode, name, sha: blob.sha });
    } else {
      const childSha = at >= 0 && entries[at].mode === '40000' ? entries[at].sha : undefined;
      const newChild = build(childSha, depth + 1);
      if (at >= 0) entries[at] = { mode: '40000', name, sha: newChild };
      else entries.push({ mode: '40000', name, sha: newChild });
    }
    return store.put('tree', buildTree(entries));
  };
  return build(treeSha, 0);
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function deflate(data: Buffer): Buffer {
  return deflateSync(data);
}
export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}
