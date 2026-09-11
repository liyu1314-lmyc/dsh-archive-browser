/**
 * Client-half integration test with a fake DOM / ModuleLoader / fetch.
 *
 * Runs the REAL lib/client.js (no browser) and exercises:
 *   load module -> factory -> apply(ctx) -> register entry -> render entry
 *   -> click entry -> panel built in document.body -> list fetched
 *   -> click "恢复到侧边栏" -> restore fetched with the right sessionId
 *   -> click "查看内容" -> read fetched -> transcript rendered
 *
 * Usage: node tests/client_harness.js
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const CLIENT = path.join(import.meta.dirname, '..', 'lib', 'client.js');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? ' :: ' + detail : ''));
  if (!ok) failures += 1;
}

// ── fake DOM ────────────────────────────────────────────────────────────
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    children: [],
    parentNode: null,
    textContent: '',
    handlers: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of this.handlers[type] || []) fn(event || { preventDefault() {}, stopPropagation() {} });
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  return node;
}
const body = makeNode('body');
const documentStub = {
  body,
  createElement: (tag) => makeNode(tag),
};

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}
function findAll(root, predicate) {
  return walk(root).filter(predicate);
}
function textOf(node) {
  if (node.tagName === '#TEXT') return node.data;
  return (node.textContent || '') + node.children.map(textOf).join('');
}
function findButton(root, label) {
  return findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === label)[0];
}
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── fake fetch ──────────────────────────────────────────────────────────
const calls = [];
const SESSIONS = [
  { id: 'session-a', title: '会话A', workspaceTitle: 'ws', userCount: 2, assistantCount: 3, firstMessage: '第一句话A', lastActivity: 1789000000000 },
  { id: 'session-b', title: '会话B', workspaceTitle: 'ws', userCount: 1, assistantCount: 0, firstMessage: '第一句话B', lastActivity: 1789000001000 },
];
const TRANSCRIPT = {
  meta: { id: 'session-a', title: '会话A', cwd: 'D:\\x', createdAt: 1789000000000 },
  turns: [
    { role: 'user', text: '你好呀' },
    { role: 'assistant', text: '你好！' },
  ],
  turnCount: 2,
  totalChars: 10,
  truncated: false,
};

let fetchImpl = async (url, init) => {
  const method = String(url).split('/').pop();
  calls.push({ method, body: init && init.body ? JSON.parse(init.body) : null });
  let value;
  if (method === 'list') value = { count: SESSIONS.length, sessions: SESSIONS };
  else if (method === 'read') value = TRANSCRIPT;
  else if (method === 'restore') value = { changed: true, remaining: 1 };
  else value = { logged: true };
  return { status: 200, json: async () => ({ ok: true, value }) };
};

// ── load the real client module ─────────────────────────────────────────
const src = fs.readFileSync(CLIENT, 'utf8');
let loaderDef = null;
const windowStub = { __ModuleLoader__: { load: (def) => { loaderDef = def; } } };
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: (url, init) => fetchImpl(url, init),
  navigator: { clipboard: { writeText: async () => {} } },
  console,
  Date,
  JSON,
  Error,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Promise,
  Set,
  Map,
  Math,
  setTimeout,
  setImmediate,
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'client.js' });

console.log('=== 1) module load ===');
check('module registered via __ModuleLoader__.load', loaderDef !== null);
check('module id matches package name', loaderDef && loaderDef.id === 'dsh-archive-browser', loaderDef && loaderDef.id);

const exportsObj = loaderDef.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('unexpected require: ' + name);
});
check('exports.apply is a function', typeof exportsObj.apply === 'function');

// ── fake cordis ctx + slots ─────────────────────────────────────────────
let registeredComponent = null;
const slotsStub = {
  inject(_key, cb) {
    cb();
    return () => {};
  },
  register(options, component) {
    registeredComponent = component;
    return () => {};
  },
};
const workspacesStub = {
  list: {
    getSnapshot: () => ({ archivedSessionIds: ['session-a', 'session-b'] }),
    subscribe: () => () => {},
  },
};
const sessionsStub = {
  list: { getSnapshot: () => ({ byId: {}, ids: [] }) },
  fork: async () => 'session-child',
  open: () => {},
};
const ctx = {
  get(name) {
    if (name === 'slots') return slotsStub;
    if (name === 'workspaces') return workspacesStub;
    if (name === 'sessions') return sessionsStub;
    return undefined;
  },
  effect(fn) {
    fn();
  },
  emit() {},
};

console.log('\n=== 2) apply + entry registration ===');
exportsObj.apply(ctx);
check('an entry component was registered', typeof registeredComponent === 'function');

const entryElement = registeredComponent();
check('entry renders a button', entryElement && entryElement.type === 'button');
check('entry has an onClick handler', typeof entryElement.props.onClick === 'function');
check('entry label mentions 已归档', textOf({ textContent: '', children: [] }) !== undefined);

console.log('\n=== 3) click entry -> panel built in document.body ===');
entryElement.props.onClick();
await flush();
await flush();
check('panel attached to document.body', body.children.length === 1, 'body children=' + body.children.length);
const panel = body.children[0];
check('panel has data marker', panel.getAttribute('data-archive-browser-panel') === '');
check('list request was sent', calls.some((c) => c.method === 'list'), JSON.stringify(calls.map((c) => c.method)));
check('two session rows rendered', findAll(panel, (n) => n.tagName === 'STRONG').length >= 3,
  'strong count=' + findAll(panel, (n) => n.tagName === 'STRONG').length);
check('row has 4 action buttons', ['查看内容', '恢复到侧边栏', '引入当前对话', '岔出继续对话']
  .every((label) => findButton(panel, label) !== undefined));

console.log('\n=== 4) click 恢复到侧边栏 ===');
const restoreBtn = findButton(panel, '恢复到侧边栏');
restoreBtn.dispatch('click');
await flush();
await flush();
const restoreCall = calls.find((c) => c.method === 'restore');
check('restore request sent', restoreCall !== undefined);
check('restore used the first row id', restoreCall && restoreCall.body && restoreCall.body.sessionId === 'session-a',
  restoreCall ? JSON.stringify(restoreCall.body) : 'none');

console.log('\n=== 5) click 查看内容 -> transcript ===');
const panel2 = body.children[0];
const viewBtn = findButton(panel2, '查看内容');
viewBtn.dispatch('click');
await flush();
await flush();
const readCall = calls.find((c) => c.method === 'read');
check('read request sent', readCall !== undefined);
check('read used the right id', readCall && readCall.body && readCall.body.sessionId === 'session-a');
const allText = textOf(body.children[0]);
check('transcript text rendered', allText.includes('你好呀') && allText.includes('你好！'), allText.slice(0, 120));

console.log('\n=== 6) click 关闭 removes the panel ===');
const closeBtn = findButton(body.children[0], '关闭');
closeBtn.dispatch('click');
check('panel removed from body', body.children.length === 0, 'body children=' + body.children.length);

console.log('\n' + (failures === 0 ? 'ALL CLIENT-HARNESS CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
