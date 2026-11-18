// Git smart HTTP: pkt-line framing, packfiles (read with OFS/REF delta resolution, write plain),
// upload-pack in protocol v0 and v2 (ls-refs and fetch, with shallow deepen), and receive-pack v0
// with report-status. Written against the wire contract in the kit's RULES.txt and the suite's own
// client (sdk/conformance/git-client.ts).

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  Forge, ObjectStore, ZERO_SHA, commitClosure, parseCommit, reachableObjects,
  type ObjectType, type Repo,
} from './store.ts';
import { deflate, inflate } from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a buffer into packets; returns the packets and the unparsed remainder (raw pack bytes). */
export function parsePackets(buffer: Buffer, start = 0): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let i = start;
  while (i + 4 <= buffer.length) {
    const header = buffer.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
      return { packets, rest: i };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (length < 4 || i + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(i + 4, i + length) });
    i += length;
  }
  return { packets, rest: i };
}

// ---------------------------------------------------------------- packfiles

const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeObjectHeader(type: ObjectType, size: number): Buffer {
  let value = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size >>= 4;
  const bytes: number[] = [];
  while (size > 0) {
    bytes.push(value | 0x80);
    value = size & 0x7f;
    size >>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

const packEntryCache = new Map<string, Buffer>();

/** Build a pack of the given objects, plain (no deltas), in the order given. */
export function buildPack(store: ObjectStore, shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    let entry = packEntryCache.get(sha);
    if (!entry) {
      const obj = store.get(sha);
      if (!obj) continue;
      entry = Buffer.concat([encodeObjectHeader(obj.type, obj.data.length), deflate(obj.data)]);
      packEntryCache.set(sha, entry);
    }
    parts.push(entry);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) offset |= delta[i++] << (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) size |= delta[i++] << (8 * bit);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: ObjectType;
  data?: Buffer;
  deltaBaseSha?: string;
  deltaBaseOffset?: number;
  delta?: Buffer;
  offset: number;
}

/** Parse a pack into entries (deltas unresolved), verifying the trailer checksum. */
export async function parsePack(pack: Buffer): Promise<PackEntry[]> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  let i = 12;
  const offsetToIndex = new Map<number, number>();
  for (let n = 0; n < count; n += 1) {
    const start = i;
    let byte = pack[i++];
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { type: ID_TYPES[typeId] ?? 'blob', offset: start };
    if (typeId === 6) {
      // OFS_DELTA
      let b = pack[i++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[i++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      entry.deltaBaseOffset = start - offset;
      entry.type = 'blob'; // resolved later from the base
    } else if (typeId === 7) {
      // REF_DELTA
      entry.deltaBaseSha = pack.subarray(i, i + 20).toString('hex');
      i += 20;
      entry.type = 'blob';
    }
    // The compressed data runs until the inflater stops.
    const inflated = inflateWithLength(pack, i);
    entry.data = inflated.data;
    if (entry.deltaBaseSha !== undefined || entry.deltaBaseOffset !== undefined) {
      entry.delta = inflated.data;
      entry.data = undefined;
    } else if (inflated.data.length !== size) {
      throw new Error('pack object size mismatch');
    }
    i += inflated.consumed;
    offsetToIndex.set(start, entries.length);
    entries.push(entry);
  }
  // Resolve deltas.
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolve = (entry: PackEntry, depth: number): { type: ObjectType; data: Buffer } => {
    if (entry.data !== undefined) return { type: entry.type, data: entry.data };
    if (depth > 64) throw new Error('delta chain too deep');
    let base: { type: ObjectType; data: Buffer };
    if (entry.deltaBaseOffset !== undefined) {
      const baseEntry = byOffset.get(entry.deltaBaseOffset);
      if (!baseEntry) throw new Error('ofs delta base missing');
      base = resolve(baseEntry, depth + 1);
    } else {
      throw new Error('ref delta resolved by caller');
    }
    const data = applyDelta(base.data, entry.delta!);
    entry.type = base.type;
    entry.data = data;
    return { type: base.type, data };
  };
  for (const entry of entries) {
    if (entry.deltaBaseOffset !== undefined) resolve(entry, 0);
  }
  return entries;
}

/** Inflate one zlib stream starting at `offset`, reporting the exact input bytes consumed.
 *  inflateSync succeeds on any prefix that covers the whole stream (trailing bytes are ignored)
 *  and fails on every shorter one, so the consumed length is the shortest inflating prefix:
 *  bracket it exponentially, then binary-search inside the bracket. */
function inflateWithLength(data: Buffer, offset: number): { data: Buffer; consumed: number } {
  const remaining = data.length - offset;
  let hi = 1;
  for (;;) {
    try {
      inflateSync(data.subarray(offset, offset + hi));
      break;
    } catch {
      if (hi >= remaining) throw new Error('inflate failed');
      hi = Math.min(remaining, hi * 2);
    }
  }
  let lo = Math.floor(hi / 2);
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(data.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  // hi is the shortest prefix known to inflate, except when hi == lo + 1 came from probing:
  // verify hi inflates and hi-1 does not; adjust if the probe landed exactly.
  try {
    inflateSync(data.subarray(offset, offset + hi - 1));
    hi = hi - 1;
    while (hi > 1) {
      try {
        inflateSync(data.subarray(offset, offset + hi - 1));
        hi -= 1;
      } catch { break; }
    }
  } catch { /* hi is minimal */ }
  return { data: inflateSync(data.subarray(offset, offset + hi)), consumed: hi };
}

// ---------------------------------------------------------------- shared helpers

/** Objects to send for `wants` minus the closure of `haves`, honouring a shallow depth.
 *  With a depth, the window is the commits within `depth` generations of the wants (the want
 *  itself is generation 0), regardless of haves: a deepen request names its current shallow
 *  commits in `shallowIn`, and the boundary moves to the window's edge — those commits are
 *  reported shallow, and former boundary commits now inside the window are unshallowed. */
export function collectFetchObjects(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth?: number,
  shallowIn: string[] = [],
): { objects: string[]; shallow: string[]; unshallow: string[] } {
  if (depth !== undefined) {
    const window = new Map<string, number>();
    const queue: Array<{ sha: string; depth: number }> = wants.map((sha) => ({ sha, depth: 0 }));
    while (queue.length > 0) {
      const { sha, depth: d } = queue.shift()!;
      const obj = store.get(sha);
      if (!obj) continue;
      if (obj.type !== 'commit') continue;
      if (window.has(sha)) continue;
      window.set(sha, d);
      if (d + 1 < depth) {
        for (const parent of parseCommit(obj.data).parents) queue.push({ sha: parent, depth: d + 1 });
      }
    }
    const send = new Set<string>();
    for (const sha of window.keys()) reachableObjects(store, sha, send);
    // Subtract what haves outside the window already give the client.
    for (const have of haves) {
      if (window.has(have)) continue;
      if (store.get(have)?.type === 'commit') {
        const outside = new Set<string>();
        for (const sha of commitClosure(store, have).keys()) reachableObjects(store, sha, outside);
        for (const sha of outside) {
          // Keep anything a window commit still needs.
          send.delete(sha);
        }
        for (const sha of window.keys()) reachableObjects(store, sha, send);
      }
    }
    for (const want of wants) {
      if (store.has(want) && store.get(want)?.type !== 'commit') reachableObjects(store, want, send);
    }
    const shallow: string[] = [];
    for (const [sha] of window) {
      const info = parseCommit(store.get(sha)!.data);
      if (info.parents.some((p) => !window.has(p))) shallow.push(sha);
    }
    const unshallow = shallowIn.filter((sha) => window.has(sha) && !shallow.includes(sha));
    return { objects: [...send], shallow, unshallow };
  }
  const haveCommits = new Set<string>();
  for (const have of haves) {
    if (store.get(have)?.type === 'commit') {
      for (const sha of commitClosure(store, have).keys()) haveCommits.add(sha);
    }
  }
  const send = new Set<string>();
  const seenCommits = new Map<string, number>();
  const queue: Array<{ sha: string; depth: number }> = wants
    .filter((w) => store.has(w))
    .map((sha) => ({ sha, depth: 0 }));
  while (queue.length > 0) {
    const { sha, depth: d } = queue.shift()!;
    const obj = store.get(sha);
    if (!obj) continue;
    if (obj.type !== 'commit') {
      if (!haveCommits.has(sha)) reachableObjects(store, sha, send);
      continue;
    }
    if (seenCommits.has(sha)) continue;
    seenCommits.set(sha, d);
    if (haveCommits.has(sha)) continue;
    reachableObjects(store, sha, send);
    const info = parseCommit(obj.data);
    for (const parent of info.parents) queue.push({ sha: parent, depth: d + 1 });
  }
  if (haveCommits.size > 0) {
    const haveObjects = new Set<string>();
    for (const sha of haveCommits) reachableObjects(store, sha, haveObjects);
    for (const sha of haveObjects) send.delete(sha);
    for (const sha of haveCommits) send.delete(sha);
  }
  for (const sha of seenCommits.keys()) {
    if (!haveCommits.has(sha) && store.has(sha)) send.add(sha);
  }
  return { objects: [...send], shallow: [], unshallow: [] };
}

/** Is `ancestor` reachable from `descendant` through commit parents? Breadth-first from the
 *  descendant with an early exit: a fast-forward's old tip is a step or two away. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    const obj = store.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'makefun-forge/1.0';

export function v2Advertisement(): Buffer {
  const lines = [
    'version 2',
    `agent=${AGENT}`,
    'ls-refs=unborn peel symrefs',
    'fetch=shallow wait-for-done',
    'object-format=sha1',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
}

export function v0Advertisement(service: string, forge: Forge, repo: Repo): Buffer {
  const caps = service === 'git-receive-pack'
    ? 'report-status report-status-v2 delete-refs side-band-64k ofs-delta'
    : 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = forge.allRefs(repo);
  const headSha = repo.refs.get(`refs/heads/${repo.headBranch}`);
  const lines: Array<{ text: string; caps?: string }> = [];
  if (headSha) lines.push({ text: `${headSha} HEAD`, caps });
  for (const [name, sha] of refs) lines.push({ text: `${sha} ${name}`, caps: lines.length === 0 ? caps : undefined });
  if (lines.length === 0) lines.push({ text: `${ZERO_SHA} capabilities^{}`, caps });
  for (const line of lines) {
    const payload = line.caps ? `${line.text}\0${line.caps}\n` : `${line.text}\n`;
    parts.push(pktLine(payload));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function refLines(forge: Forge, repo: Repo, args: LsRefsArgs): Buffer {
  const out: Buffer[] = [];
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headSha = repo.refs.get(`refs/heads/${repo.headBranch}`);
  if (matches('HEAD')) {
    if (headSha) {
      let line = `${headSha} HEAD`;
      if (args.symrefs) line += ` symref-target:refs/heads/${repo.headBranch}`;
      out.push(pktLine(`${line}\n`));
    } else if (args.unborn) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.headBranch}\n`));
    }
  }
  for (const [name, sha] of forge.allRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    const obj = forge.objects.get(sha);
    if (args.peel && obj?.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) line += ` peeled:${target}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

export function parseTagTarget(data: Buffer): string | undefined {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : undefined;
}

/** Handle a v2 upload-pack POST body; returns the response body. */
export function handleUploadPackV2(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else args.push(line);
  }
  if (command === 'ls-refs') {
    const ls: LsRefsArgs = { prefixes: [], peel: false, symrefs: false, unborn: false };
    for (const arg of args) {
      if (arg === 'peel') ls.peel = true;
      else if (arg === 'symrefs') ls.symrefs = true;
      else if (arg === 'unborn') ls.unborn = true;
      else if (arg.startsWith('ref-prefix ')) ls.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return refLines(forge, repo, ls);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | undefined;
    let done = false;
    let waitForDone = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7));
      else if (arg === 'done') done = true;
      else if (arg === 'wait-for-done') waitForDone = true;
    }
    if (!done && waitForDone) {
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      const common = haves.filter((h) => forge.objects.has(h));
      if (common.length === 0) parts.push(pktLine('NAK\n'));
      else for (const sha of common) parts.push(pktLine(`ACK ${sha}\n`));
      parts.push(pktLine('ready\n'), PKT_FLUSH);
      return Buffer.concat(parts);
    }
    return fetchResponse(forge, wants, haves, depth, true, shallowIn);
  }
  return Buffer.concat([pktLine('error: unknown command\n'), PKT_FLUSH]);
}

/** The packfile section (v2) or sideband stream (v0) answering a fetch. */
function fetchResponse(forge: Forge, wants: string[], haves: string[], depth: number | undefined, v2: boolean, shallowIn: string[] = []): Buffer {
  const { objects, shallow, unshallow } = collectFetchObjects(forge.objects, wants, haves, depth, shallowIn);
  const pack = buildPack(forge.objects, objects);
  const parts: Buffer[] = [];
  if (v2) {
    if (depth !== undefined || shallowIn.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
  } else {
    for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(pktLine('NAK\n'));
  }
  // Sideband: band 1 carries the pack in chunks of at most 65515 payload bytes.
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1])])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Handle a v0 upload-pack POST body. */
export function handleUploadPackV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
  }
  return fetchResponse(forge, wants, haves, depth, false, shallowIn);
}

// ---------------------------------------------------------------- receive-pack

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Handle a receive-pack POST: parse ref updates + pack, store objects, move refs, report. */
export async function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): Promise<Buffer> {
  const { packets, rest } = parsePackets(body);
  const updates: RefUpdate[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (match) updates.push({ oldSha: match[1], newSha: match[2], ref: match[3] });
  }
  const packBytes = body.subarray(rest);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const entries = await parsePack(packBytes);
      // REF deltas resolve against objects already in the store or earlier in the pack.
      const pending = new Map<string, { type: ObjectType; data: Buffer }>();
      for (const entry of entries) {
        if (entry.data !== undefined && entry.deltaBaseSha === undefined && entry.deltaBaseOffset === undefined) {
          pending.set(shaOf(entry.type, entry.data), { type: entry.type, data: entry.data });
        }
      }
      let progressed = true;
      const remaining = entries.filter((e) => e.deltaBaseSha !== undefined);
      const resolvedData = new Map<string, Buffer>();
      while (remaining.length > 0 && progressed) {
        progressed = false;
        for (let i = remaining.length - 1; i >= 0; i -= 1) {
          const entry = remaining[i];
          const baseSha = entry.deltaBaseSha!;
          const base = pending.get(baseSha) ?? readStoreObject(forge, baseSha) ?? (resolvedData.has(baseSha) ? { type: 'blob' as ObjectType, data: resolvedData.get(baseSha)! } : undefined);
          if (!base) continue;
          const data = applyDelta(base.data, entry.delta!);
          resolvedData.set(shaOf(base.type, data), data);
          pending.set(shaOf(base.type, data), { type: base.type, data });
          remaining.splice(i, 1);
          progressed = true;
        }
      }
      if (remaining.length > 0) throw new Error('delta base not found');
      for (const entry of entries) {
        if (entry.deltaBaseSha !== undefined) continue;
        if (entry.data === undefined) throw new Error('unresolved pack entry');
        forge.objects.put(entry.type, entry.data);
      }
      for (const [sha, obj] of pending) {
        if (!forge.objects.has(sha)) forge.objects.put(obj.type, obj.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: string[] = [];
  report.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'error'}\n`);
  if (unpackOk) {
    for (const update of updates) {
      const result = applyRefUpdate(forge, repo, update);
      report.push(result === null ? `ok ${update.ref}\n` : `ng ${update.ref} ${result}\n`);
    }
  }
  const parts: Buffer[] = [];
  for (const line of report) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function readStoreObject(forge: Forge, sha: string): { type: ObjectType; data: Buffer } | undefined {
  const obj = forge.objects.get(sha);
  return obj ? { type: obj.type, data: obj.data } : undefined;
}

export function shaOf(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

/** Apply one ref update with fast-forward enforcement; returns an error string or null. */
function applyRefUpdate(forge: Forge, repo: Repo, update: RefUpdate): string | null {
  const current = repo.refs.get(update.ref) ?? ZERO_SHA;
  if (update.newSha === ZERO_SHA) {
    // delete
    if (current === ZERO_SHA) return 'reference not found';
    repo.refs.delete(update.ref);
    return null;
  }
  if (!forge.objects.has(update.newSha)) return 'bad object';
  if (current !== ZERO_SHA) {
    const newObj = forge.objects.get(update.newSha);
    const curObj = forge.objects.get(current);
    if (newObj?.type === 'commit' && curObj?.type === 'commit') {
      if (!isAncestor(forge.objects, current, update.newSha)) return 'non-fast-forward';
    }
  }
  repo.refs.set(update.ref, update.newSha);
  if (update.ref === `refs/heads/${repo.defaultBranch}` || repo.headBranch === '') {
    // HEAD follows the default branch; nothing else to do.
  }
  return null;
}
