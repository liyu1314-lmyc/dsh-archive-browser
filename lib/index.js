/**
 * dsh-archive-browser — host half.
 *
 * A static Cordis host plugin: reads archived session artifacts from disk and
 * exposes them to the client half over one Package-private JSON route.
 *
 * Route: POST /archive-browser/api/<method>
 *   list     -> { count, sessions: Meta[] }
 *   read     -> { meta, turns, totalChars, truncated, turnCount }
 *   restore  -> { ok, changed, remaining, backup }
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  listArchivedSessions,
  readArchivedTranscript,
  resolveDshHome,
} from './archive-core.js';

/** webServer serves the JSON route; workspaceRegistry owns the archive set. */
export const inject = ['webServer', 'workspaceRegistry'];

const ROUTE_PREFIX = '/archive-browser/api/';

/** Load beacon: proves the host half mounted (read by the plugin author). */
function beacon(line) {
  try {
    fs.appendFileSync(
      path.join('D:', '鲸鱼小妹的工作', 'plugin-dev', '.archive-browser-loaded.log'),
      new Date().toISOString() + ' ' + line + '\n',
      'utf8',
    );
  } catch {
    /* beacon is best-effort */
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function requireSessionId(payload) {
  const id = payload?.sessionId;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('sessionId is required');
  return id;
}

/**
 * Restore (un-archive) a session through the workspace registry.
 *
 * Mirrors WorkspaceRegistry.archiveSession: the registry keeps its own
 * in-memory state, so writing workspace.json directly would be clobbered by
 * the next registry write and would fail its startup divergence check. The
 * registry write also emits `{type:'archived'}` on the follow feed, so the
 * sidebar un-hides the row without a reload.
 *
 * @param registry - the `workspaceRegistry` service (ctx.workspaceRegistry).
 * @param sessionId - the archived session to restore.
 * @returns { changed, remaining } - `changed` is false when it was not archived.
 */
export async function unarchiveViaRegistry(registry, sessionId) {
  const enqueue = registry.enqueueOperation;
  const requireState = registry.requireState;
  const setState = registry.setState;
  if (typeof enqueue !== 'function' || typeof requireState !== 'function' || typeof setState !== 'function') {
    throw new Error('workspaceRegistry does not expose enqueueOperation/requireState/setState');
  }
  return enqueue.call(registry, async () => {
    const state = requireState.call(registry);
    const current = state.archivedSessionIds ?? [];
    if (!current.includes(sessionId)) return { changed: false, remaining: current.length };
    const next = current.filter((id) => id !== sessionId);
    await setState.call(registry, { ...state, archivedSessionIds: next });
    return { changed: true, remaining: next.length };
  });
}

/**
 * Dispatch one archive API method. Pure data in / pure JSON out.
 * @param method - route tail after ROUTE_PREFIX.
 * @param payload - parsed JSON request body.
 * @param home - DSH home directory (file-backed list/read).
 * @param registry - workspaceRegistry service (restore).
 */
export async function dispatchArchiveMethod(method, payload, home = resolveDshHome(), registry = undefined) {
  switch (method) {
    case 'log': {
      // Diagnostic channel: the client half reports its internal state here so
      // the plugin author can read it from disk without renderer console access.
      const message = typeof payload?.message === 'string' ? payload.message : '(no message)';
      beacon('CLIENT ' + message);
      return { logged: true };
    }
    case 'list': {
      const listed = listArchivedSessions(home);
      beacon('list -> ' + listed.count + ' archived');
      return listed;
    }
    case 'read': {
      const transcript = readArchivedTranscript(home, requireSessionId(payload));
      beacon('read ' + payload.sessionId + ' -> ' + transcript.turnCount + ' turns');
      return transcript;
    }
    case 'restore': {
      if (registry === undefined) throw new Error('workspaceRegistry unavailable; cannot restore');
      const sessionId = requireSessionId(payload);
      const result = await unarchiveViaRegistry(registry, sessionId);
      beacon('restore ' + sessionId + ' -> changed=' + result.changed + ' remaining=' + result.remaining);
      return result;
    }
    default:
      throw new Error(`unknown archive api method "${method}"`);
  }
}

/** Host plugin entry. */
export function apply(ctx) {
  beacon('host apply invoked; dsh home = ' + resolveDshHome());
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/archive-browser/api',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST required' } });
            return;
          }
          let pathname;
          try {
            pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
          } catch {
            writeJson(res, 400, { ok: false, error: { code: 'bad-url', message: 'malformed url' } });
            return;
          }
          if (!pathname.startsWith(ROUTE_PREFIX)) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown archive route' } });
            return;
          }
          const method = pathname.slice(ROUTE_PREFIX.length);
          if (method === '' || method.includes('/')) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown archive api method' } });
            return;
          }
          try {
            const payload = await readJsonBody(req);
            const value = await dispatchArchiveMethod(method, payload, resolveDshHome(), ctx.workspaceRegistry);
            writeJson(res, 200, { ok: true, value });
          } catch (error) {
            writeJson(res, 200, {
              ok: false,
              error: { code: 'archive-error', message: error instanceof Error ? error.message : String(error) },
            });
          }
        },
      }),
    'dsh-archive-browser: /archive-browser/api routes',
  );
}
