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
