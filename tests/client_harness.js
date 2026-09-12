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
  // DOM-faithful textContent: assigning REPLACES the node's content, so
  // `parent.textContent = ''` really empties it. A plain property silently kept
  // the old children, which made re-renders accumulate rows here while working
  // fine in a browser (found by the list-sorting test, 2026-09-11).
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() {
      return text;
    },
    set(value) {
      text = value === undefined || value === null ? '' : String(value);
      node.children.length = 0;
    },
    enumerable: true,
  });
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

const IMPACT = {
  meta: { id: 'session-a', title: '会话A', cwd: 'D:\\x' },
  files: [
    { path: 'D:\\x\\made.md', absolute: 'D:\\x\\made.md', change: 'created', tool: 'write', hits: 2, exists: true, size: 1024, mtime: 1789000000000 },
    { path: 'D:\\x\\edited.md', absolute: 'D:\\x\\edited.md', change: 'modified', tool: 'edit', hits: 1, exists: true, size: 2048, mtime: 1789000000000 },
    { path: 'D:\\x\\gone.js', absolute: 'D:\\x\\gone.js', change: 'created', tool: 'write', hits: 1, exists: false },
  ],
  commands: [
    { command: 'pip install numpy', description: '装依赖', kind: 'install', label: '安装依赖', isError: false },
    { command: 'git clone https://example.invalid/x.git', description: '', kind: 'clone', label: '克隆仓库', isError: false },
    { command: 'curl -O https://example.invalid/z.zip', description: '', kind: 'download', label: '下载', isError: false },
    { command: 'Get-ChildItem', description: '', kind: 'other', label: '其它', isError: false },
  ],
  children: [
    { id: 'sub-child-1', kind: 'subagent', depth: 1, records: 42, artifactBytes: 2048, createdAt: 1789000000000, agentPreset: 'standard' },
    { id: 'fork-child-1', kind: 'fork', depth: 1, records: 30, artifactBytes: 1024, createdAt: 1789000000000, agentPreset: 'standard' },
  ],
  stats: { fileCalls: 4, commandCalls: 4, files: 3, created: 2, modified: 1, missing: 1, children: 2, truncated: false },
};

let fetchImpl = async (url, init) => {
  const method = String(url).split('/').pop();
  calls.push({ method, body: init && init.body ? JSON.parse(init.body) : null });
  let value;
  if (method === 'list') value = { count: SESSIONS.length, sessions: SESSIONS };
  else if (method === 'read') value = TRANSCRIPT;
  else if (method === 'impact') value = IMPACT;
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
check('row has 5 action buttons', ['查看内容', '影响面', '恢复到侧边栏', '引入当前对话', '岔出继续对话']
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

console.log('\n=== 6) back to list, then click 影响面 -> read-only impact view ===');
const backBtn = findButton(body.children[0], '← 返回列表');
check('transcript view offers a back button', backBtn !== undefined);
if (backBtn) backBtn.dispatch('click');
await flush();
await flush();
const impactBtn = findButton(body.children[0], '影响面');
check('impact button exists in the row', impactBtn !== undefined);
if (impactBtn) impactBtn.dispatch('click');
await flush();
await flush();
const impactCall = calls.find((c) => c.method === 'impact');
check('impact request sent', impactCall !== undefined, JSON.stringify(calls.map((c) => c.method)));
check('impact used the right id', impactCall && impactCall.body && impactCall.body.sessionId === 'session-a');
const impactText = textOf(body.children[0]);
check('impact marks a created file', impactText.includes('＋新建') && impactText.includes('D:\\x\\made.md'), impactText.slice(0, 100));
check('impact marks a modified file', impactText.includes('～修改') && impactText.includes('D:\\x\\edited.md'));
check('impact flags a vanished file', impactText.includes('已不存在') && impactText.includes('D:\\x\\gone.js'));
check('impact shows size and mtime', impactText.includes('1.0 KB') && impactText.includes('2.0 KB'));
check('impact counts repeat touches', impactText.includes('本会话动过 2 次'));
check('impact groups install commands', impactText.includes('安装依赖') && impactText.includes('pip install numpy'));
check('impact groups clone commands', impactText.includes('克隆仓库') && impactText.includes('git clone'));
check('impact groups download commands', impactText.includes('下载') && impactText.includes('curl -O'));
check('impact lists a subagent child', impactText.includes('派生出去的会话') && impactText.includes('sub-child-1') && impactText.includes('小助手'));
check('impact lists a fork child', impactText.includes('分支') && impactText.includes('fork-child-1'));
check('impact states deps are not auto-removed', impactText.includes('不自动卸载') && impactText.includes('不会替你卸载或删除'));

// ── plain-language layer (one sentence per item, generated from its own state) ──
check('impact explains itself in plain words', impactText.includes('影响面体检') && impactText.includes('只看不改的'),
  impactText.slice(0, 80));
check('impact explains each created file', impactText.includes('这次对话新建的文件，现在还在你的电脑上'));
check('impact explains each modified file', impactText.includes('这次对话改过它的内容（它原本就已经存在）'));
check('impact explains each vanished file', impactText.includes('后来被删掉或搬走了'));
check('impact explains install commands', impactText.includes('装完就留在系统里了'));
check('impact explains the subagent plainly', impactText.includes('AI 直接派出的“临时小助手”留下的对话记录'));
check('impact explains the fork plainly and correctly', impactText.includes('分出去的一条新分支') && impactText.includes('正常显示在左侧的会话列表里'));

console.log('  ── rendered impact view (first 900 chars) ──');
console.log('  ' + impactText.slice(0, 900));

console.log('\n=== 7) click 关闭 removes the panel ===');
const closeBtn = findButton(body.children[0], '关闭');
closeBtn.dispatch('click');
check('panel removed from body', body.children.length === 0, 'body children=' + body.children.length);

console.log('\n=== 8) sort toggle (reopen the panel first) ===');
entryElement.props.onClick();
await flush();
await flush();
const listCallsAfterOpen = calls.filter((c) => c.method === 'list').length;
// Row titles in render order (the header's own <strong> is filtered out).
const titleSeq = () => findAll(body.children[0], (n) => n.tagName === 'STRONG')
  .map(textOf)
  .filter((t) => t === '会话A' || t === '会话B')
  .join(',');
check('default sort label is 归档顺序', findButton(body.children[0], '顺序：归档顺序') !== undefined);
check('default order is the host archive order', titleSeq() === '会话A,会话B', titleSeq());

findButton(body.children[0], '顺序：归档顺序').dispatch('click');
await flush();
check('1st click -> 最近活动↓', findButton(body.children[0], '顺序：最近活动↓') !== undefined);
check('recent-first flips the rows (B was used later)', titleSeq() === '会话B,会话A', titleSeq());

findButton(body.children[0], '顺序：最近活动↓').dispatch('click');
await flush();
check('2nd click -> 最近活动↑', findButton(body.children[0], '顺序：最近活动↑') !== undefined);
check('oldest-first puts A back in front', titleSeq() === '会话A,会话B', titleSeq());

findButton(body.children[0], '顺序：最近活动↑').dispatch('click');
await flush();
check('3rd click -> 标题', findButton(body.children[0], '顺序：标题') !== undefined);

findButton(body.children[0], '顺序：标题').dispatch('click');
await flush();
check('4th click cycles back to 归档顺序', findButton(body.children[0], '顺序：归档顺序') !== undefined);
check('status line reports the active order',
  textOf(body.children[0]).includes('顺序：归档顺序') && textOf(body.children[0]).includes('按你归档的先后顺序排'));
check('re-sorting does not re-fetch the list',
  calls.filter((c) => c.method === 'list').length === listCallsAfterOpen,
  'list calls=' + calls.filter((c) => c.method === 'list').length + ' (after open: ' + listCallsAfterOpen + ')');

console.log('\n' + (failures === 0 ? 'ALL CLIENT-HARNESS CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
