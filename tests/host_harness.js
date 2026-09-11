/**
 * Host-half HTTP route test with fake req/res and a MOCK registry.
 *
 * Verifies the layer above `dispatchArchiveMethod`: method gating, URL parsing,
 * JSON body reading, the {ok,value}/{ok:false,error} envelope, and the registry
 * write path — all WITHOUT touching the live archive storage (the registry is a
 * mock, so `restore` mutates the mock only).
 *
 * Usage: node tests/host_harness.js
 */
import { apply } from '../lib/index.js';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? ' :: ' + detail : ''));
  if (!ok) failures += 1;
}

// ── fake cordis ctx ─────────────────────────────────────────────────────
let route = null;
const registryState = {
  initialized: true,
  workspaceIds: ['w1'],
  archivedSessionIds: [
    'session-4e673826-52f2-41f4-8f3b-d542768dab9f',
    'session-dca2d1f2-3853-4fbc-b989-afc3a3416890',
  ],
};
const registryCalls = [];
const mockRegistry = {
  enqueueOperation(op) {
    registryCalls.push('enqueueOperation');
    return op();
  },
  requireState() {
    registryCalls.push('requireState');
    return registryState;
  },
  async setState(next) {
    registryCalls.push('setState');
    registryState.archivedSessionIds = next.archivedSessionIds;
  },
};

const ctx = {
  get: () => undefined,
  effect(fn) {
    fn();
  },
  webServer: {
    register(r) {
      route = r;
      return () => {};
    },
  },
  workspaceRegistry: mockRegistry,
};

console.log('=== 1) apply registers the route ===');
apply(ctx);
check('route registered', route !== null);
check('route is a prefix route', route && route.kind === 'prefix');
check('route path is /archive-browser/api', route && route.path === '/archive-browser/api');
check('route has a handler', route && typeof route.handler === 'function');

// ── fake req/res ────────────────────────────────────────────────────────
function makeReq(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}
function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text === undefined ? '' : String(text);
    },
  };
  return res;
}
async function callRoute(method, url, body) {
  const res = makeRes();
  await route.handler(makeReq(method, url, body), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* non-JSON body */
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

console.log('\n=== 2) method gating + routing ===');
const getRes = await callRoute('GET', '/archive-browser/api/list');
check('GET is rejected with 405', getRes.status === 405, 'status=' + getRes.status);
check('405 envelope has ok:false', getRes.json && getRes.json.ok === false);

const badRoute = await callRoute('POST', '/nope/api/list', {});
check('unknown prefix is 404', badRoute.status === 404, 'status=' + badRoute.status);

const badMethod = await callRoute('POST', '/archive-browser/api/does-not-exist', {});
check('unknown api method returns ok:false envelope', badMethod.json && badMethod.json.ok === false,
  JSON.stringify(badMethod.json));

console.log('\n=== 3) list (real session data, read-only) ===');
const listRes = await callRoute('POST', '/archive-browser/api/list', {});
check('list returns 200', listRes.status === 200, 'status=' + listRes.status);
check('list envelope ok:true', listRes.json && listRes.json.ok === true);
const sessions = listRes.json && listRes.json.value ? listRes.json.value.sessions : [];
check('list returns archived sessions', Array.isArray(sessions) && sessions.length > 0, 'count=' + sessions.length);
check('each row has an id and a title', sessions.every((s) => s.id && s.title));
check('content-type is JSON', String(listRes.headers && listRes.headers['content-type']).includes('application/json'));

console.log('\n=== 4) log diagnostics channel ===');
const logRes = await callRoute('POST', '/archive-browser/api/log', { message: 'harness ping' });
check('log returns ok:true', logRes.json && logRes.json.ok === true, JSON.stringify(logRes.json));

console.log('\n=== 5) read (real session artifact, read-only) ===');
const firstId = sessions.find((s) => !s.missing && s.userCount > 0)?.id ?? sessions[0].id;
const readRes = await callRoute('POST', '/archive-browser/api/read', { sessionId: firstId });
check('read returns ok:true', readRes.json && readRes.json.ok === true, JSON.stringify(readRes.json).slice(0, 160));
check('read returns turns', readRes.json && readRes.json.value && Array.isArray(readRes.json.value.turns));
const readMissing = await callRoute('POST', '/archive-browser/api/read', {});
check('read without sessionId fails cleanly', readMissing.json && readMissing.json.ok === false,
  JSON.stringify(readMissing.json));

console.log('\n=== 6) restore (MOCK registry — live data untouched) ===');
const before = registryState.archivedSessionIds.length;
const restoreRes = await callRoute('POST', '/archive-browser/api/restore', { sessionId: registryState.archivedSessionIds[0] });
check('restore returns ok:true', restoreRes.json && restoreRes.json.ok === true, JSON.stringify(restoreRes.json));
check('restore reports changed', restoreRes.json && restoreRes.json.value && restoreRes.json.value.changed === true);
check('mock registry lost exactly one id', registryState.archivedSessionIds.length === before - 1,
  'now=' + JSON.stringify(registryState.archivedSessionIds));
check('registry write protocol used', registryCalls.includes('enqueueOperation') && registryCalls.includes('setState'),
  registryCalls.join(' > '));

const againRes = await callRoute('POST', '/archive-browser/api/restore', { sessionId: 'session-not-archived' });
check('restoring a non-archived id is a no-op', againRes.json && againRes.json.value && againRes.json.value.changed === false,
  JSON.stringify(againRes.json && againRes.json.value));

console.log('\n' + (failures === 0 ? 'ALL HOST-HARNESS CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
