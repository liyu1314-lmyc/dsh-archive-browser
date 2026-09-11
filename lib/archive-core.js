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

// ───────────────────────────── impact analysis ─────────────────────────────
//
// "What did this session touch?" — reconstructed from the transcript alone.
//
// Verified record shapes (real logs, 2026-09-11):
//   tool/call   .data = { turn, step, callId, name, arguments }   // arguments = JSON string
//   tool/result .data.message.source.callId    <- the join key
//               .data.message.content[0].isError
//               .data.meta.diffs               // write/edit only, [{path,oldText,newText}]
//   write result text carries `<content>Created file</content>` for a NEW file
//   (`dsh-tool-fs` formatWriteOutput: `outcome.operation === 'create' ? 'Created' : 'Updated'`),
//   which is the authoritative new-vs-modified signal; `meta.diffs === []` is ambiguous
//   (it is also empty when an existing file is rewritten with identical content).

/**
 * Command classification rules; first match wins, so the most specific kind
 * (install) leads: `git clone ... && pip install ...` is an install line.
 */
const COMMAND_RULES = [
  {
    kind: 'install',
    label: '安装依赖',
    pattern:
      /\b(pip3?|pipx|uv|conda|mamba|poetry)\s+(install|add|sync)\b|\bpython[\w.]*\s+-m\s+pip\s+install\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bwinget\s+install\b|\bchoco\s+install\b|\bscoop\s+install\b|\bInstall-Module\b|\bgo\s+install\b|\bcargo\s+install\b|\bapt(-get)?\s+install\b/i,
  },
  { kind: 'clone', label: '克隆仓库', pattern: /\bgit\s+clone\b|\bgit\s+submodule\s+update\b/i },
  {
    kind: 'download',
    label: '下载',
    pattern:
      /\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\biwr\b|\bStart-BitsTransfer\b|\bgh\s+release\s+download\b|\bgit\s+(fetch|pull)\b/i,
  },
];

/** Shell tools whose `command` argument is worth reporting. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'pwsh-persistent', 'bash-persistent']);

/** Tools whose call arguments name a file they mutate. */
const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

const IMPACT_LIMITS = { files: 400, commands: 400, children: 50 };

/**
 * Classify one shell command into an install/clone/download/other bucket.
 *
 * Quoted strings are stripped before matching: a PowerShell banner like
 * `"=== test outbound (curl/Invoke-WebRequest) ==="; Get-NetTCPConnection ...`
 * must not classify the whole command as a download merely because the banner
 * names a downloader. (Found while probing real logs, 2026-09-11.)
 */
export function classifyCommand(command) {
  const text = String(command ?? '').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(text)) return { kind: rule.kind, label: rule.label };
  }
  return { kind: 'other', label: '其它' };
}

/** First non-blank line of a command, trimmed to a display width. */
function commandHead(command, max = 200) {
  const line = String(command ?? '')
    .split('\n')
    .find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/** Join the text blocks of one tool/result message. */
function resultText(record) {
  const blocks = record?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  const out = [];
  for (const block of blocks) {
    if (!Array.isArray(block?.content)) continue;
    for (const inner of block.content) {
      if (typeof inner?.text === 'string') out.push(inner.text);
    }
  }
  return out.join('\n');
}

/** Same-to-same absolute/relative resolver: relative tool paths resolve against the session cwd. */
export function resolveToolPath(raw, cwd) {
  if (path.isAbsolute(raw)) return raw;
  if (typeof cwd === 'string' && cwd.trim() !== '') return path.resolve(cwd, raw);
  return raw;
}

/**
 * Read ONLY a session's header record (the first `type:'session'` line).
 *
 * Reads a bounded prefix of the artifact and decodes just the first zstd frame,
 * so scanning many sessions for parents stays cheap. Falls back to a full read
 * when the first frame does not fit inside the prefix.
 *
 * @param artifactPath - `session.jsonl.zstd` (or plain `.jsonl`) path.
 * @returns the header record, or undefined when it cannot be read.
 */
export function readSessionHeader(artifactPath, { prefixBytes = 262144 } = {}) {
  const parseFirst = (text) => {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === 'session') return record;
    }
    return undefined;
  };

  if (!artifactPath.endsWith('.zstd')) {
    try {
      return parseFirst(fs.readFileSync(artifactPath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  let prefix;
  try {
    const fd = fs.openSync(artifactPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const take = Math.min(size, prefixBytes);
      prefix = Buffer.alloc(take);
      fs.readSync(fd, prefix, 0, take, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  try {
    const { frames } = scanZstdFrames(prefix, 1);
    if (frames.length === 1) {
      return parseFirst(zlib.zstdDecompressSync(prefix.subarray(frames[0].start, frames[0].end)).toString('utf8'));
    }
  } catch {
    /* fall through to the full read */
  }
  try {
    const buffer = fs.readFileSync(artifactPath);
    const { frames } = scanZstdFrames(buffer);
    const parts = frames.map((frame) => zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    return parseFirst(Buffer.concat(parts).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Every session header on disk, keyed by session id (one read per session). */
export function collectSessionHeaders(home = resolveDshHome()) {
  const root = path.join(home, 'sessions');
  const byId = new Map();
  if (!fs.existsSync(root)) return byId;
  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(root, group.name);
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(groupDir, entry.name);
      const artifact = ['session.jsonl.zstd', 'session.jsonl']
        .map((name) => path.join(dir, name))
        .find((candidate) => fs.existsSync(candidate));
      if (artifact === undefined) continue;
      const header = readSessionHeader(artifact);
      if (header === undefined) continue;
      let size;
      try {
        size = fs.statSync(artifact).size;
      } catch {
        size = undefined;
      }
      byId.set(entry.name, { id: entry.name, header, artifact, artifactBytes: size });
    }
  }
  return byId;
}

/**
 * Child sessions (subagents) of `sessionId`, walked to full depth.
 *
 * Subagent logs are invisible in every UI list — their id carries no `session-`
 * prefix and their header records `origin:'subagent'` + `parentSession` — so a
 * cleanup feature must know about them explicitly.
 *
 * @returns ordered [{ id, depth, createdAt, artifactBytes, records, agentPreset }]
 */
export function findChildSessions(sessionId, headers) {
  const children = [];
  const queue = [{ id: sessionId, depth: 0 }];
  while (queue.length > 0 && children.length < IMPACT_LIMITS.children) {
    const current = queue.shift();
    for (const candidate of headers.values()) {
      if (candidate.header?.parentSession !== current.id) continue;
      if (children.some((child) => child.id === candidate.id)) continue;
      const depth = current.depth + 1;
      let records;
      try {
        records = readSessionRecords(candidate.artifact).length;
      } catch {
        records = undefined;
      }
      children.push({
        id: candidate.id,
        // Two different things share `parentSession`:
        //   'subagent' — a helper run; `origin:'subagent'`, and it appears in NO
        //                UI list (the sidebar filters `origin !== 'subagent'`).
        //   'fork'     — a session branched off this one (`seedLength`, no subagent
        //                origin). It IS a normal visible session in the sidebar.
        // Conflating them would let the UI claim a fork is invisible, which is false.
        kind: candidate.header?.origin === 'subagent' ? 'subagent' : 'fork',
        depth,
        origin: candidate.header?.origin ?? '',
        agentPreset: candidate.header?.agentPreset ?? '',
        createdAt: candidate.header?.createdAt,
        artifactBytes: candidate.artifactBytes,
        records,
      });
      queue.push({ id: candidate.id, depth });
    }
  }
  return children;
}

/**
 * Reconstruct the impact of one session from its transcript records.
 *
 * Read-only: file entries are `stat`ed, never opened. Relative tool paths are
 * resolved against the session header's `cwd` before the existence check.
 *
 * @param records - parsed session records.
 * @param options.sessionId - the session being analysed.
 * @param options.stat - set false to skip filesystem checks (pure/offline tests).
 * @returns { meta, files, commands, stats }
 */
export function extractImpact(records, { sessionId, stat = true } = {}) {
  const header = records.find((r) => r?.type === 'session') ?? {};
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';

  // Join results onto calls by callId.
  const results = new Map();
  for (const record of records) {
    if (record?.type !== 'tool/result') continue;
    const data = record.data ?? {};
    const block = Array.isArray(data.message?.content) ? data.message.content[0] : undefined;
    const callId = data.message?.source?.callId ?? block?.toolCallId;
    if (typeof callId !== 'string') continue;
    results.set(callId, {
      isError: block?.isError === true,
      text: resultText(record),
      diffs: Array.isArray(data.meta?.diffs) ? data.meta.diffs.length : undefined,
    });
  }

  const files = [];
  const byPath = new Map();
  const commands = [];
  let fileCalls = 0;
  let commandCalls = 0;
  let fileCapHit = false;
  let commandCapHit = false;

  for (const record of records) {
    if (record?.type !== 'tool/call') continue;
    const call = record.data ?? {};
    const name = typeof call.name === 'string' ? call.name : '';
    let args;
    try {
      args = JSON.parse(typeof call.arguments === 'string' ? call.arguments : '{}');
    } catch {
      continue;
    }
    if (args === null || typeof args !== 'object') continue;
    const result = results.get(call.callId);
    const isError = result === undefined ? null : result.isError;

    if (SHELL_TOOLS.has(name)) {
      if (typeof args.command !== 'string' || args.command.trim() === '') continue;
      commandCalls += 1;
      if (commands.length >= IMPACT_LIMITS.commands) {
        commandCapHit = true;
        continue;
      }
      const classified = classifyCommand(args.command);
      commands.push({
        command: commandHead(args.command),
        description: typeof args.description === 'string' ? args.description : '',
        kind: classified.kind,
        label: classified.label,
        turn: call.turn,
        time: record.time,
        seq: record.seq,
        isError,
      });
      continue;
    }

    if (!MUTATION_TOOLS.has(name)) continue;
    const raw = name === 'str_replace_editor' ? args.path : args.file_path;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    fileCalls += 1;

    let change;
    if (result === undefined) change = 'unknown';
    else if (name === 'write') change = /\bCreated file\b/.test(result.text) ? 'created' : 'modified';
    else if (name === 'str_replace_editor') change = args.command === 'create' ? 'created' : 'modified';
    else change = 'modified';

    const absolute = resolveToolPath(raw, cwd);
    const existing = byPath.get(absolute);
    if (existing !== undefined) {
      existing.hits += 1;
      existing.lastSeq = record.seq;
      existing.lastTime = record.time;
      if (existing.change !== 'created' && change === 'created') existing.change = 'created';
      if (isError === true) existing.anyError = true;
      continue;
    }
    if (files.length >= IMPACT_LIMITS.files) {
      fileCapHit = true;
      continue;
    }

    let exists;
    let size;
    let mtime;
    let isDir;
    if (stat) {
      try {
        const st = fs.statSync(absolute);
        exists = true;
        size = st.size;
        mtime = st.mtimeMs;
        isDir = st.isDirectory();
      } catch {
        exists = false;
      }
    }
    const entry = {
      path: raw,
      absolute,
      change,
      tool: name,
      hits: 1,
      turn: call.turn,
      time: record.time,
      seq: record.seq,
      isError,
      anyError: isError === true,
      exists,
      size,
      mtime,
      isDir,
      diffs: result?.diffs,
    };
    byPath.set(absolute, entry);
    files.push(entry);
  }

  return {
    meta: {
      id: sessionId ?? header.id,
      cwd,
      title: undefined,
      createdAt: header.createdAt,
      agentPreset: header.agentPreset ?? '',
      parentSession: header.parentSession,
      delegationDepth: header.delegationDepth ?? 0,
    },
    files,
    commands,
    stats: {
      fileCalls,
      commandCalls,
      files: files.length,
      created: files.filter((f) => f.change === 'created').length,
      modified: files.filter((f) => f.change === 'modified').length,
      missing: files.filter((f) => f.exists === false).length,
      truncated: fileCapHit || commandCapHit,
    },
  };
}

/**
 * Full impact payload for one archived session: transcript analysis + its
 * subagent children (which never appear in any UI list).
 */
export function buildImpact(home, sessionId, { stat = true, headers } = {}) {
  const artifact = findSessionArtifact(home, sessionId);
  if (artifact === undefined) throw new Error(`session artifact not found: ${sessionId}`);
  const records = readSessionRecords(artifact);
  const impact = extractImpact(records, { sessionId, stat });
  impact.meta.title = extractMeta(records).title;
  impact.meta.artifactBytes = (() => {
    try {
      return fs.statSync(artifact).size;
    } catch {
      return undefined;
    }
  })();
  const index = headers ?? collectSessionHeaders(home);
  impact.children = findChildSessions(sessionId, index);
  impact.stats.children = impact.children.length;
  impact.stats.commandKinds = impact.commands.reduce((acc, command) => {
    acc[command.kind] = (acc[command.kind] ?? 0) + 1;
    return acc;
  }, {});
  return impact;
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
