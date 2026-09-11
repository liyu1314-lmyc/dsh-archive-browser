/**
 * dsh-archive-browser — client half (v2, vanilla-DOM panel).
 *
 * Design notes (why not React for the panel):
 *   The slot registry "abdicates" an entry whose component throws during render,
 *   and an abdicated entry never renders again. Two React-based attempts at the
 *   panel therefore died permanently the first time they threw. So:
 *     - the slot entry is a MINIMAL React button (no hooks, no Fragment, no portal)
 *     - the panel itself is plain DOM appended to document.body, created from the
 *       click handler and fully wrapped in try/catch
 *   That keeps the slot contribution trivial and makes the panel immune to slot
 *   lifecycle, clipping, pointer-events inheritance and render crashes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archive-browser',
  factory: (require) => {
    const exports = {};
    const React = require('react');
    const h = React.createElement;

    const API = '/archive-browser/api/';

    let ctxRef = { get: () => undefined };

    // ── diagnostics ─────────────────────────────────────────────────────
    let diagSeq = 0;
    function diag(message) {
      diagSeq += 1;
      try {
        fetch(API + 'log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: '#' + diagSeq + ' ' + message }),
        }).catch(() => {});
      } catch {
        /* diagnostics must never break the UI */
      }
    }

    async function call(method, payload) {
      const res = await fetch(API + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error('HTTP ' + res.status);
      }
      if (json === null || json.ok !== true) {
        throw new Error(json && json.error ? json.error.message : 'HTTP ' + res.status);
      }
      return json.value;
    }

    /** Archived rows from the client stores (no host round-trip). */
    function clientArchivedRows() {
      const sessions = ctxRef.get('sessions');
      const workspaces = ctxRef.get('workspaces');
      if (!sessions || !workspaces || !sessions.list || !workspaces.list) return null;
      const ws = workspaces.list.getSnapshot();
      const archived = ws && Array.isArray(ws.archivedSessionIds) ? ws.archivedSessionIds : null;
      if (archived === null) return null;
      const list = sessions.list.getSnapshot() || {};
      const byId = list.byId || {};
      return archived.map((id) => {
        const row = byId[id] || {};
        const titleInput = row.projectionValues && row.projectionValues.titleInput;
        const first = titleInput && titleInput.val ? titleInput.val.first : undefined;
        return {
          id,
          title: row.displayTitle || id,
          cwd: row.cwd || '',
          lastActivity: row.updatedAt,
          firstMessage: first && typeof first.text === 'string' ? first.text : '',
        };
      });
    }

    // ── vanilla DOM panel ───────────────────────────────────────────────
    let panelRoot = null;
    let listHost = null;
    let statusHost = null;
    let titleHost = null;
    let busy = false;

    // ── palette: opaque + high contrast ─────────────────────────────────
    // Translucent themes (e.g. wallpaper-engine plugins) make token-derived
    // backgrounds see-through and kill readability. So the panel resolves its
    // own OPAQUE palette: detect dark/light from the frame's text color, reuse
    // the frame background only when it is already opaque, otherwise fall back
    // to a solid color. All text colors are explicit (no opacity over
    // translucent surfaces).
    function parseColor(input) {
      if (input === undefined || input === null) return null;
      const s = String(input).trim().toLowerCase();
      if (s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return [0, 0, 0, 0];
      let m = /^#([0-9a-f]{3})$/.exec(s);
      if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
      m = /^#([0-9a-f]{6})$/.exec(s);
      if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
      m = /^rgba?\(([^)]+)\)$/.exec(s);
      if (m) {
        const parts = m[1].split(/[,\s/]+/).filter((x) => x !== '').map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
          return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
        }
      }
      return null;
    }
    function relativeLuminance(rgb) {
      return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    }

    function resolvePalette() {
      let dark = true;
      let base = null;
      try {
        const probe = document.querySelector('[data-dsh-frame]') || document.body || document.documentElement;
        const cs = getComputedStyle(probe);
        const text = parseColor(cs.color);
        if (text && text[3] > 0) dark = relativeLuminance(text) > 0.5;
        const bg = parseColor(cs.backgroundColor);
        if (bg && bg[3] >= 0.99) base = [Math.round(bg[0]), Math.round(bg[1]), Math.round(bg[2])];
      } catch {
        /* fall through to defaults */
      }
      if (base === null) base = dark ? [22, 23, 26] : [252, 252, 254];
      const fg = dark ? 'rgb(240,241,244)' : 'rgb(20,22,26)';
      const subtle = dark ? 'rgba(240,241,244,0.72)' : 'rgba(20,22,26,0.70)';
      const border = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)';
      const rowBg = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)';
      const btnBg = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)';
      return { base: 'rgb(' + base.join(',') + ')', fg, subtle, border, rowBg, btnBg, dark };
    }

    function makeStyles(p) {
      return {
        overlay:
          'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;pointer-events:auto;',
        backdrop:
          'position:absolute;inset:0;background:rgba(0,0,0,' + (p.dark ? '0.62' : '0.45') + ');' +
          'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:auto;',
        card:
          'position:relative;display:flex;flex-direction:column;gap:10px;padding:16px;' +
          'width:min(760px,calc(100vw - 48px));height:min(72vh,660px);border-radius:14px;' +
          // fully opaque so no wallpaper bleeds through
          'background-color:' + p.base + ';background-image:none;color:' + p.fg + ';' +
          'border:1px solid ' + p.border + ';' +
          'box-shadow:0 24px 70px rgba(0,0,0,0.6);font-size:13px;line-height:1.5;pointer-events:auto;',
        header: 'display:flex;align-items:center;justify-content:space-between;gap:8px;',
        row:
          'display:flex;flex-direction:column;gap:5px;padding:10px 12px;margin-bottom:8px;' +
          'background:' + p.rowBg + ';border:1px solid ' + p.border + ';border-radius:9px;',
        rowTop: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
        title: 'font-size:13px;font-weight:600;color:' + p.fg + ';',
        meta: 'font-size:11px;color:' + p.subtle + ';',
        preview: 'font-size:12px;color:' + p.fg + ';word-break:break-word;',
        actions: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;',
        btn:
          'cursor:pointer;font-size:12px;padding:3px 10px;border-radius:7px;' +
          'background:' + p.btnBg + ';color:' + p.fg + ';border:1px solid ' + p.border + ';',
        listBody: 'flex:1;overflow:auto;min-height:0;',
        status: 'font-size:12px;min-height:16px;color:' + p.subtle + ';',
        turnRole: 'font-size:11px;color:' + p.subtle + ';margin-bottom:2px;',
        turnText: 'font-size:12px;color:' + p.fg + ';white-space:pre-wrap;word-break:break-word;',
        ok: 'font-size:12px;min-height:16px;color:' + (p.dark ? '#6ee7a8' : '#1a7f4b') + ';',
        err: 'font-size:12px;min-height:16px;color:' + (p.dark ? '#ff8b8b' : '#c92a2a') + ';',
        // ── impact view ──
        sectionTitle: 'font-size:12px;font-weight:600;margin:12px 0 4px;color:' + p.fg + ';',
        mono: 'font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11px;word-break:break-all;',
        rowLine: 'display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid ' + p.border + ';',
        badge: 'display:inline-block;font-size:11px;line-height:1.6;padding:0 6px;border-radius:5px;white-space:nowrap;',
        colorText: 'color:' + p.fg + ';',
        colorMiss: 'color:' + (p.dark ? '#ff9b9b' : '#c92a2a') + ';',
        // Plain-language note: a left-bordered aside under each item.
        explain:
          'font-size:11px;line-height:1.6;color:' + p.subtle + ';border-left:2px solid ' + p.border +
          ';padding-left:7px;margin:3px 0 1px;',
        badgeCreatedFg: p.dark ? '#6ee7a8' : '#1a7f4b',
        badgeCreatedBg: p.dark ? 'rgba(110,231,168,0.16)' : 'rgba(26,127,75,0.12)',
        badgeModifiedFg: p.dark ? '#7cc0ff' : '#1b5e9e',
        badgeModifiedBg: p.dark ? 'rgba(124,192,255,0.16)' : 'rgba(27,94,158,0.12)',
        kindFg: p.dark
          ? { install: '#ffb26b', clone: '#c9a2ff', download: '#7cc0ff', other: '#b9bcc4' }
          : { install: '#a15c00', clone: '#6b3fa0', download: '#1b5e9e', other: '#5c6068' },
        kindBg: p.dark
          ? { install: 'rgba(255,178,107,0.18)', clone: 'rgba(201,162,255,0.18)', download: 'rgba(124,192,255,0.18)', other: 'rgba(255,255,255,0.08)' }
          : { install: 'rgba(161,92,0,0.14)', clone: 'rgba(107,63,160,0.14)', download: 'rgba(27,94,158,0.14)', other: 'rgba(0,0,0,0.06)' },
      };
    }

    let S = null;

    function el(tag, style, text) {
      const node = document.createElement(tag);
      if (style) node.setAttribute('style', style);
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    function button(label, onClick, styles) {
      const b = el('button', (styles || '') + ';' + S.btn, label);
      b.setAttribute('type', 'button');
      b.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          onClick();
        } catch (error) {
          diag('button handler threw: ' + (error && error.message ? error.message : String(error)));
        }
      });
      return b;
    }

    function setStatus(text, isError) {
      if (!statusHost || S === null) return;
      statusHost.textContent = text || '';
      statusHost.setAttribute('style', isError ? S.err : S.ok);
    }

    function setTitle(count) {
      if (!titleHost) return;
      titleHost.textContent = count ? '已归档会话（' + count + '）' : '已归档会话';
    }

    function closePanel() {
      try {
        if (panelRoot && panelRoot.parentNode) panelRoot.parentNode.removeChild(panelRoot);
      } catch {
        /* ignore */
      }
      panelRoot = null;
      listHost = null;
      statusHost = null;
      titleHost = null;
      busy = false;
    }

    function togglePanel() {
      if (panelRoot) {
        diag('panel toggle -> close');
        closePanel();
        return;
      }
      diag('panel toggle -> open');
      buildPanel();
    }

    function buildPanel() {
      S = makeStyles(resolvePalette());
      // HMR safety: a hot-reloaded module starts with fresh state (panelRoot === null)
      // while the PREVIOUS instance's panel may still sit in the DOM. Without this,
      // toggling the entry after a reload stacks a second panel on top of the old one.
      try {
        const stale = document.querySelectorAll('[data-archive-browser-panel]');
        for (const node of stale) {
          if (node.parentNode) node.parentNode.removeChild(node);
        }
      } catch (error) {
        /* document stub without querySelectorAll (offline harness) — ignore */
      }
      const root = el('div', S.overlay);
      root.setAttribute('data-archive-browser-panel', '');
      const backdrop = el('div', S.backdrop);
      backdrop.addEventListener('click', () => closePanel());

      const card = el('div', S.card);
      const header = el('div', S.header);
      titleHost = el('strong', S.title, '已归档会话');
      const headerActions = el('div', 'display:flex;gap:6px;');
      headerActions.appendChild(
        button('刷新', () => {
          refreshList();
        }),
      );
      headerActions.appendChild(
        button('关闭', () => {
          closePanel();
        }),
      );
      header.appendChild(titleHost);
      header.appendChild(headerActions);

      statusHost = el('div', S.status);
      listHost = el('div', S.listBody);

      card.appendChild(header);
      card.appendChild(statusHost);
      card.appendChild(listHost);
      root.appendChild(backdrop);
      root.appendChild(card);
      document.body.appendChild(root);

      panelRoot = root;
      refreshList();
    }

    async function refreshList() {
      if (!listHost) return;
      if (busy) return;
      busy = true;
      setStatus('正在读取归档…', false);
      listHost.textContent = '';
      let sessions = null;
      let degraded = false;
      try {
        const value = await call('list');
        sessions = (value && value.sessions) || [];
        diag('list ok: ' + sessions.length + ' rows');
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        diag('list FAILED: ' + message);
        const fallback = clientArchivedRows();
        if (fallback !== null) {
          sessions = fallback;
          degraded = true;
          diag('list degraded to client source: ' + fallback.length + ' rows');
        } else {
          busy = false;
          setStatus('读取失败：' + message, true);
          return;
        }
      }
      renderRows(sessions);
      setTitle(sessions.length);
      setStatus(
        degraded
          ? '宿主接口不可用，已降级为客户端列表（查看/恢复仍需要宿主）'
          : sessions.length
            ? '共 ' + sessions.length + ' 个归档会话'
            : '没有已归档的会话。',
        false,
      );
      busy = false;
    }

    function renderRows(sessions) {
      if (!listHost) return;
      listHost.textContent = '';
      for (const session of sessions) {
        listHost.appendChild(buildRow(session));
      }
    }

    function buildRow(session) {
      const row = el('div', S.row);
      const top = el('div', S.rowTop);
      top.appendChild(el('strong', S.title, session.title || '(untitled)'));
      const time = session.lastActivity || session.createdAt;
      top.appendChild(el('span', S.meta + 'white-space:nowrap;', time ? new Date(time).toLocaleString() : ''));
      row.appendChild(top);

      const parts = [];
      if (session.workspaceTitle || session.cwd) parts.push(session.workspaceTitle || session.cwd);
      if (session.userCount !== undefined || session.assistantCount !== undefined) {
        parts.push((session.userCount || 0) + ' 用户 / ' + (session.assistantCount || 0) + ' 助手');
      }
      if (session.missing) parts.push('⚠ 文件缺失');
      row.appendChild(el('div', S.meta, parts.join(' · ')));

      if (session.firstMessage) row.appendChild(el('div', S.preview, String(session.firstMessage).slice(0, 160)));

      const actions = el('div', S.actions);
      actions.appendChild(button('查看内容', () => showDetail(session.id)));
      actions.appendChild(button('影响面', () => showImpact(session.id)));
      actions.appendChild(button('恢复到侧边栏', () => restore(session.id)));
      actions.appendChild(button('引入当前对话', () => inject(session.id)));
      actions.appendChild(button('岔出继续对话', () => forkSession(session.id)));
      row.appendChild(actions);
      return row;
    }

    async function showDetail(sessionId) {
      if (!listHost) return;
      setStatus('正在读取会话内容…', false);
      try {
        const detail = await call('read', { sessionId });
        diag('read ok: ' + detail.turnCount + ' turns');
        listHost.textContent = '';
        const meta = detail.meta || {};
        const head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;');
        head.appendChild(
          button('← 返回列表', () => {
            refreshList();
          }),
        );
        head.appendChild(el('strong', S.title, meta.title || meta.id));
        head.appendChild(el('span', S.meta, (detail.turnCount || 0) + ' 轮' + (detail.truncated ? '（已截断）' : '')));
        listHost.appendChild(head);
        for (const turn of detail.turns || []) {
          const item = el('div', 'margin-bottom:10px;');
          item.appendChild(el('div', S.turnRole, turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : '工具'));
          item.appendChild(el('div', S.turnText, turn.text));
          listHost.appendChild(item);
        }
        setStatus('', false);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        diag('read FAILED: ' + message);
        setStatus('读取内容失败：' + message, true);
      }
    }

    async function restore(sessionId) {
      setStatus('正在恢复到侧边栏…', false);
      try {
        const result = await call('restore', { sessionId });
        diag('restore ok: ' + JSON.stringify(result));
        setStatus(result && result.changed ? '已恢复到侧边栏，该会话已回到左侧列表。' : '该会话本来就不在归档中。', false);
        await refreshList();
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        diag('restore FAILED: ' + message);
        setStatus('恢复失败：' + message, true);
      }
    }

    function digestFrom(detail) {
      const meta = detail.meta || {};
      const lines = ['# 归档会话：' + (meta.title || meta.id)];
      if (meta.cwd) lines.push('- 工作区：' + meta.cwd);
      if (meta.createdAt) lines.push('- 创建：' + new Date(meta.createdAt).toLocaleString());
      lines.push('');
      for (const turn of detail.turns || []) {
        if (turn.role === 'tool') continue;
        lines.push((turn.role === 'user' ? '**用户**：' : '**助手**：') + turn.text);
        lines.push('');
      }
      return lines.join('\n');
    }

    async function inject(sessionId) {
      setStatus('正在整理归档内容…', false);
      try {
        const detail = await call('read', { sessionId });
        const digest = digestFrom(detail);
        let how = null;
        try {
          const conversation = ctxRef.get('conversation');
          if (conversation) {
            if (typeof conversation.insertText === 'function') {
              conversation.insertText(digest);
              how = 'input';
            } else if (typeof conversation.setDraft === 'function') {
              conversation.setDraft(digest);
              how = 'input';
            }
          }
        } catch {
          /* fall through */
        }
        if (how === null) {
          try {
            if (typeof ctxRef.emit === 'function') {
              ctxRef.emit('slash/input-insert-text', { text: digest });
              how = 'input';
            }
          } catch {
            /* fall through */
          }
        }
        if (how === null && navigator && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(digest);
          how = 'clipboard';
        }
        diag('inject -> ' + String(how));
        setStatus(
          how === 'input'
            ? '已把归档内容插入当前输入框。'
            : how === 'clipboard'
              ? '已复制到剪贴板，请用 Ctrl+V 粘贴到输入框。'
              : '无法自动插入，请改用「查看内容」手动复制。',
          false,
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        diag('inject FAILED: ' + message);
        setStatus('引入失败：' + message, true);
      }
    }

    async function forkSession(sessionId) {
      setStatus('正在岔出新会话…', false);
      try {
        const sessions = ctxRef.get('sessions');
        if (!sessions || typeof sessions.fork !== 'function') {
          setStatus('会话服务不可用，无法岔出。', true);
          return;
        }
        const childId = await sessions.fork({ sessionId, increaseTitle: true });
        if (typeof sessions.open === 'function') sessions.open(childId);
        diag('fork ok -> ' + childId);
        setStatus('已岔出新会话：' + childId, false);
        closePanel();
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        diag('fork FAILED: ' + message);
        setStatus('岔出失败：' + message, true);
      }
    }

    // ── impact view: read-only "what did this session touch" ────────────
    const KIND_ORDER = ['install', 'clone', 'download', 'other'];
    const KIND_TITLE = { install: '安装依赖', clone: '克隆仓库', download: '下载', other: '其它' };

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(2) + ' MB';
    }

    function fmtTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      try {
        return new Date(ms).toLocaleString();
      } catch (error) {
        return '';
      }
    }

    // ── plain-language layer ────────────────────────────────────────────
    // Every item gets a sentence generated from ITS OWN state (new vs changed,
    // still there vs gone, subagent depth) — never one canned line repeated
    // down the list. Wording stays concrete: no "artifact", "dependency",
    // "tool call", "side effect" style jargon.
    function plainFile(file) {
      const gone = file.exists === false;
      if (file.change === 'created') {
        return gone
          ? '这次对话新建的文件，但现在已经不在原来的位置了（后来被删掉或搬走了）。'
          : '这次对话新建的文件，现在还在你的电脑上。';
      }
      if (file.change === 'modified') {
        return gone
          ? '这次对话改过它的内容，但现在已经不在原来的位置了。'
          : '这次对话改过它的内容（它原本就已经存在），现在还在。';
      }
      return '没能确认它是新建还是改动 —— 这次操作没有留下结果，可能当时被中断了。';
    }

    function plainKind(kind) {
      if (kind === 'install') {
        return '这类操作会往电脑里装新的软件包。装完就留在系统里了，别的对话也可能在用，所以这里只列出来、不自动卸载。';
      }
      if (kind === 'clone') {
        return '这类操作会从网上把一个完整的代码仓库复制到本地，比较占磁盘空间。';
      }
      if (kind === 'download') {
        return '这类操作会从网上下载文件存到本地，会占磁盘空间。';
      }
      return '查看、列出、运行之类的操作，一般不会在电脑上留下长期的东西。';
    }

    function plainChild(child) {
      if (child.kind === 'fork') {
        return '这是从这段对话分出去的一条新分支（相当于从这里另开一条线继续聊）。它会正常显示在左侧的会话列表里，' +
          '不属于“看不见”的那一类。';
      }
      const who = child.depth <= 1 ? 'AI 直接派出的“临时小助手”' : '上一级小助手再派出的“下一级小助手”';
      return '这是' + who + '留下的对话记录。界面里看不到它，但它会一直占磁盘。';
    }

    function chip(text, fg, bg) {
      return el('span', S.badge + 'color:' + fg + ';background:' + bg + ';', text);
    }

    function renderImpact(impact) {
      if (!listHost) return;
      listHost.textContent = '';
      const meta = impact.meta || {};
      const stats = impact.stats || {};

      const head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
      head.appendChild(button('← 返回列表', () => {
        refreshList();
      }));
      head.appendChild(el('strong', S.title, meta.title || meta.id || ''));
      listHost.appendChild(head);
      listHost.appendChild(el('div', S.explain, '这是这段对话的“影响面体检”：它在你的电脑上留下过哪些痕迹。'));
      listHost.appendChild(
        el('div', S.explain,
          '这个页面是只看不改的 —— 不会修改、也不会删除你的任何东西。文件只做三项检查：还在不在、多大、什么时候改的。'),
      );

      // ── files ──
      const files = impact.files || [];
      listHost.appendChild(el('div', S.sectionTitle, '产出 / 修改的文件（' + files.length + '）'));
      listHost.appendChild(el('div', S.explain, '下面是这次对话新建或改过的文件。留不留、要不要删，都由你来定。'));
      if (files.length === 0) listHost.appendChild(el('div', S.meta, '（这次对话没有新建或修改任何文件）'));
      for (const file of files) {
        const row = el('div', S.rowLine);
        if (file.change === 'created') row.appendChild(chip('＋新建', S.badgeCreatedFg, S.badgeCreatedBg));
        else if (file.change === 'modified') row.appendChild(chip('～修改', S.badgeModifiedFg, S.badgeModifiedBg));
        else row.appendChild(chip('？未知', S.kindFg.other, S.kindBg.other));
        const body = el('div', 'flex:1;min-width:0;');
        body.appendChild(el('div', S.mono + (file.exists === false ? S.colorMiss : S.colorText), file.path || file.absolute || ''));
        const bits = [];
        if (file.exists === false) bits.push('⚠ 已不存在');
        else if (file.exists === true) bits.push('还在');
        const size = fmtBytes(file.size);
        if (size) bits.push(size);
        const when = fmtTime(file.mtime);
        if (when) bits.push(when);
        if (file.hits > 1) bits.push('本会话动过 ' + file.hits + ' 次');
        if (file.anyError) bits.push('有失败');
        if (bits.length) body.appendChild(el('div', S.meta, bits.join(' · ')));
        body.appendChild(el('div', S.explain, plainFile(file)));
        row.appendChild(body);
        listHost.appendChild(row);
      }

      // ── commands, grouped by kind ──
      const commands = impact.commands || [];
      const totalCommands = stats.commandCalls === undefined ? commands.length : stats.commandCalls;
      listHost.appendChild(el('div', S.sectionTitle, '执行过的命令（' + totalCommands + '）'));
      listHost.appendChild(el('div', S.explain, '下面是这次对话在电脑上运行过的命令行操作，按用途分了类。'));
      if (commands.length === 0) listHost.appendChild(el('div', S.meta, '（这次对话没有运行过命令行）'));
      const byKind = {};
      for (const command of commands) {
        const key = KIND_ORDER.indexOf(command.kind) >= 0 ? command.kind : 'other';
        if (byKind[key] === undefined) byKind[key] = [];
        byKind[key].push(command);
      }
      for (const kind of KIND_ORDER) {
        const list = byKind[kind];
        if (list === undefined || list.length === 0) continue;
        listHost.appendChild(
          el('div', S.meta + 'margin:8px 0 2px;font-weight:600;', KIND_TITLE[kind] + '（' + list.length + '）'),
        );
        listHost.appendChild(el('div', S.explain, plainKind(kind)));
        for (const command of list) {
          const row = el('div', S.rowLine);
          row.appendChild(chip(command.label || KIND_TITLE[kind], S.kindFg[kind], S.kindBg[kind]));
          const body = el('div', 'flex:1;min-width:0;');
          body.appendChild(el('div', S.mono + S.colorText, command.command || ''));
          const notes = [];
          if (command.description) notes.push('↳ ' + command.description);
          if (command.isError === true) notes.push('⚠ 该命令执行失败');
          if (notes.length) body.appendChild(el('div', S.meta, notes.join('   ')));
          row.appendChild(body);
          listHost.appendChild(row);
        }
      }

      // ── derived sessions: subagent helpers (hidden) and forks (visible) ──
      const children = impact.children || [];
      if (children.length > 0) {
        listHost.appendChild(el('div', S.sectionTitle, '派生出去的会话（' + children.length + '）'));
        listHost.appendChild(
          el('div', S.explain, 'AI 干活时派出的“小助手”，以及从这段对话分出去的“分支”，都会列在这里 —— 两者性质不一样，看下面的说明。'),
        );
        for (const child of children) {
          const row = el('div', S.rowLine);
          const badge =
            child.kind === 'fork' ? '分支' : child.depth > 1 ? '小助手 ' + child.depth + ' 级' : '小助手';
          row.appendChild(chip(badge, S.kindFg.clone, S.kindBg.clone));
          const body = el('div', 'flex:1;min-width:0;');
          body.appendChild(el('div', S.mono + S.colorText, child.id));
          const bits = [];
          if (child.records !== undefined) bits.push(child.records + ' 条记录');
          const size = fmtBytes(child.artifactBytes);
          if (size) bits.push(size);
          const when = fmtTime(child.createdAt);
          if (when) bits.push(when);
          if (child.agentPreset) bits.push(child.agentPreset);
          if (bits.length) body.appendChild(el('div', S.meta, bits.join(' · ')));
          body.appendChild(el('div', S.explain, plainChild(child)));
          row.appendChild(body);
          listHost.appendChild(row);
        }
      }

      listHost.appendChild(
        el('div', S.explain + 'margin-top:12px;',
          '最后提醒一句：这个页面只告诉你“这段对话装过什么、下载过什么”，不会替你卸载或删除 —— ' +
          '一个软件包可能别的对话或别的程序正在用，乱删会把其它东西弄坏。'),
      );
    }

    async function showImpact(sessionId) {
      if (!listHost) return;
      setStatus('正在分析影响面（读取转录，只做只读检查）…', false);
      try {
        const impact = await call('impact', { sessionId });
        diag(
          'impact ok: files=' + impact.files.length + ' commands=' + impact.commands.length +
            ' children=' + impact.children.length,
        );
        renderImpact(impact);
        const stats = impact.stats || {};
        setStatus(
          '文件 ' + stats.files + '（新建 ' + stats.created + ' / 修改 ' + stats.modified +
            '，已不存在 ' + stats.missing + '） · 命令 ' + stats.commandCalls +
            ' · 子代理会话 ' + stats.children + (stats.truncated ? ' · 结果已截断' : ''),
          false,
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        diag('impact FAILED: ' + message);
        setStatus('影响面分析失败：' + message, true);
      }
    }

    // ── slot entry: minimal React button, no hooks ──────────────────────
    function ArchiveEntry() {
      return h(
        'button',
        {
          type: 'button',
          title: '浏览已归档的会话',
          onClick: () => togglePanel(),
          style: {
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1,
            padding: '4px 8px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.4))',
            background: 'transparent',
            color: 'inherit',
          },
        },
        '\u{1F5C4} 已归档',
      );
    }

    // ── plugin ──────────────────────────────────────────────────────────
    function apply(ctx) {
      ctxRef = ctx;
      diag('apply called; hasSlots=' + String(ctx.get('slots') !== undefined));
      const slots = ctx.get('slots');
      if (slots === undefined) {
        diag('apply aborted: slots missing');
        return;
      }
      ctx.effect(() => {
        const dispose = slots.inject('sidebar.footer.action', () => {
          try {
            const off = slots.register({ name: 'sidebar.footer.action', id: 'archive-browser' }, ArchiveEntry);
            diag('entry registered');
            return off;
          } catch (error) {
            diag('entry register threw: ' + (error && error.message ? error.message : String(error)));
            throw error;
          }
        });
        return dispose;
      }, 'archive-browser: sidebar entry');
    }

    exports.apply = apply;
    exports.inject = [];
    return exports;
  },
});
