/**
 * dsh-archive-browser — host-side archive core.
 *
 * Pure Node ESM (no DSH imports) so it can be unit-tested standalone and
 * reused by the Cordis host plugin entry.
 *
 * Responsibilities:
 *  - locate the DSH home (`.dsh`) and the workspace storage file
 *  - enumerate archived session ids
 *  - locate + decode `session.jsonl.zstd` (concatenated zstd frames)
 *  - extract list metadata (title / time / first message / cwd / counts)
 *  - build a readable transcript
 *  - restore (un-archive) a session by rewriting workspace.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 4247762216;

/** Resolve the DSH home directory (contains sessions/, storages/, profiles/). */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME ?? env.DSH_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/** Read the workspace storage file (archive registry lives here). */
export function readWorkspaceStorage(home = resolveDshHome()) {
  const file = path.join(home, 'storages', 'workspace.json');
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  const archived = json?.global?.archivedSessionIds ?? [];
  const workspaces = json?.tables?.workspaces ?? {};
  return { file, json, archived, workspaces };
}

/** All workspace entries as {id, path, title, sessionIds}. */
export function listWorkspaces(workspaces) {
  return Object.entries(workspaces).map(([id, w]) => ({
    id,
    path: w?.path ?? '',
    title: w?.title ?? w?.path ?? '',
    sessionIds: w?.sessionIds ?? [],
  }));
}

/** Locate `<home>/sessions/<encoded-workspace>/<sessionId>/session.jsonl.zstd`. */
export function findSessionArtifact(home, sessionId) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return undefined;
  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const dir = path.join(root, group.name, sessionId);
    for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Structurally scan concatenated zstd frames (algorithm mirrored from
 * @deepseek-ai/dsh-session-persistence-jsonl). Returns complete frame ranges;
 * a trailing torn frame is reported via `tornStart`.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Decode a full session artifact into parsed JSONL records. */
export function readSessionRecords(artifactPath) {
  const buffer = fs.readFileSync(artifactPath);
  let text;
  if (artifactPath.endsWith('.zstd')) {
    const { frames, tornStart } = scanZstdFrames(buffer);
    if (frames.length === 0) throw new Error('empty or header-less session log');
    const parts = [];
    for (const frame of frames) parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    text = Buffer.concat(parts).toString('utf8');
    if (tornStart !== undefined) {
      const decoder = zlib.createZstdDecompress({ finishFlush: zlib.constants.ZSTD_e_flush });
      const chunks = [];
      decoder.on('data', (c) => chunks.push(c));
      try {
        decoder.end(buffer.subarray(tornStart));
        text += Buffer.concat(chunks).toString('utf8');
      } catch { /* torn tail is best-effort */ }
    }
  } else {
    text = buffer.toString('utf8');
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try { records.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return records;
}

/** Flatten a message `data.content` array into plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (typeof part.text === 'string') out.push(part.text);
    else if (typeof part.content === 'string') out.push(part.content);
  }
  return out.join('\n');
}

/** Extract the compact list metadata the sidebar needs. */
export function extractMeta(records) {
  const header = records.find((r) => r?.type === 'session') ?? {};
  let title;
  for (const r of records) {
    if (r?.type === 'session/title' && typeof r.data?.title === 'string' && r.data.title.trim() !== '') title = r.data.title;
  }
  let firstMessage = '';
  let userCount = 0;
  let assistantCount = 0;
  let firstTime;
  let lastTime;
  for (const r of records) {
    const t = r?.time;
    if (typeof t === 'number') {
      if (firstTime === undefined || t < firstTime) firstTime = t;
      if (lastTime === undefined || t > lastTime) lastTime = t;
    }
    if (r?.type === 'user/message') {
      userCount += 1;
      if (firstMessage === '') {
        const text = contentToText(r.data?.content);
        if (text.trim() !== '') firstMessage = text.replace(/\s+/g, ' ').trim();
      }
    } else if (r?.type === 'assistant/message') assistantCount += 1;
  }
  return {
    id: header.id,
    title: title ?? (firstMessage !== '' ? firstMessage.slice(0, 30) : '(untitled)'),
    firstMessage,
    cwd: header.cwd ?? '',
    agentPreset: header.agentPreset ?? '',
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : firstTime,
    lastActivity: lastTime,
    userCount,
    assistantCount,
    forkedFrom: header.parentSession ?? undefined,
    recordCount: records.length,
  };
}

/** Build a readable transcript (user / assistant text turns, in order). */
export function buildTranscript(records, { maxChars = 200000 } = {}) {
  const turns = [];
  for (const r of records) {
    if (r?.type === 'user/message') {
      const text = contentToText(r.data?.content).trim();
      if (text !== '') turns.push({ role: 'user', text, time: r.time });
    } else if (r?.type === 'assistant/message') {
      const text = contentToText(r.data?.content).trim();
      if (text !== '') turns.push({ role: 'assistant', text, time: r.time });
    } else if (r?.type === 'tool/call') {
      const name = r.data?.name ?? r.data?.toolName ?? 'tool';
      turns.push({ role: 'tool', text: String(name), time: r.time });
    }
  }
  let total = 0;
  const clipped = [];
  for (const turn of turns) {
    total += turn.text.length;
    if (total > maxChars) break;
    clipped.push(turn);
  }
  return { turns: clipped, totalChars: total, truncated: total > maxChars, turnCount: turns.length };
}

/** One archived session's list entry. */
export function describeArchivedSession(home, sessionId) {
  const artifact = findSessionArtifact(home, sessionId);
  if (artifact === undefined) {
    return { id: sessionId, missing: true, title: '(artifact missing)', recordCount: 0 };
  }
  const records = readSessionRecords(artifact);
  return { ...extractMeta(records), missing: false, artifact };
}

/** Enumerate archived sessions with metadata. */
export function listArchivedSessions(home = resolveDshHome()) {
  const { archived, workspaces } = readWorkspaceStorage(home);
  const byPath = new Map(listWorkspaces(workspaces).map((w) => [w.path, w.title]));
  const sessions = archived.map((id) => {
    const entry = describeArchivedSession(home, id);
    return { ...entry, workspaceTitle: byPath.get(entry.cwd) ?? entry.cwd ?? '' };
  });
  return { count: sessions.length, sessions };
}

/** Read one archived session's transcript. */
export function readArchivedTranscript(home, sessionId) {
  const artifact = findSessionArtifact(home, sessionId);
  if (artifact === undefined) throw new Error(`session artifact not found: ${sessionId}`);
  const records = readSessionRecords(artifact);
  return { meta: extractMeta(records), ...buildTranscript(records) };
}

/*
 * NOTE — restoring (un-archiving) is deliberately NOT implemented here.
 *
 * `workspace.json` must never be written directly: WorkspaceRegistry keeps its
 * own in-memory state, so a file edit is clobbered by the next registry write
 * and trips its startup divergence check. The only supported path is the
 * registry itself (`enqueueOperation` + `requireState` + `setState`), mirrored
 * from `WorkspaceRegistry.archiveSession`. See `unarchiveViaRegistry` in
 * ./index.js. This module stays read-only + deletion-free on purpose.
 */
