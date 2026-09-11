# dsh-archive-browser

浏览 **DeepSeek Harness (DSH)** 中已归档的会话，并对其执行"再调用"。

> **背景**：DSH 的「归档」是**单向**操作——官方只有 `archiveSession`，**没有任何取消归档的入口**，
> 且归档后的会话会被界面从所有列表里过滤掉（`sessionVisible` 中的 `!archived.has(id)`）。
> 本插件补上了这块能力：把归档会话重新"捞"出来看、恢复、引用、续聊。

[![DSH](https://img.shields.io/badge/DSH-plugin-4b6bfb)](https://github.com/anywhere-labs/deepseek-harness-desktop)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## ✨ 功能

侧边栏底部会出现一个 **🗄 已归档** 按钮，点开面板后，每个归档会话提供四项操作：

| 操作 | 说明 | 实现方式 |
|---|---|---|
| **查看内容** | 面板内渲染完整对话转录（用户 / 助手 / 工具调用） | host 读取并逐帧解码会话文件 |
| **恢复到侧边栏** | 从归档集合移除，会话重新出现在左侧列表（**无需刷新**） | 写 `workspaceRegistry`，触发官方增量广播 |
| **引入当前对话** | 把归档内容整理成 digest 写入当前输入框 | `conversation` 服务 → `slash/input-insert-text` 事件 → 剪贴板（三层降级）|
| **岔出继续对话** | 从归档会话岔出一个新的活会话并打开 | `sessions.fork({ increaseTitle: true })` |

列表显示：**标题、最后活动时间、工作区、消息数（用户/助手）、首条消息预览**，以及岔出关系。

## 📦 安装

### 方式一：官方 CLI（推荐）

```powershell
dsh plugin --profile desktop add dsh-archive-browser
```

### 方式二：本地未发布包（手动挂载）

```powershell
# 1) 把包放进 profile 的 node_modules
#    <DSH_HOME>\profiles\desktop\node_modules\dsh-archive-browser\

# 2) 在该 profile 的 cordis.patch.yml 追加：
#    - insert:
#        - id: archive-browser
#          name: 'dsh-archive-browser'

# 3) 重启 DSH Desktop
```

> 修改 **host 半（`lib/index.js`）** 后必须重启；修改 **client 半（`lib/client.js`）** 会被
> `dsh-client-hmr` 自动热重载（约 500ms 内），不必重启、不必刷新。

## 🧱 架构

```
lib/archive-core.js   host 纯逻辑：定位会话文件、多帧 zstd 解码、元数据提取、转录
lib/index.js          host 插件入口：Cordis apply + webServer 路由
lib/client.js         client UI：极简 React 入口按钮 + 原生 DOM 面板
cordis.patch.yml      挂载声明（insert 行）
tests/                离线测试（假 DOM / 假 req-res / 模拟 registry）
```

**host 路由**：`POST /archive-browser/api/<method>`
`list` / `read` / `restore` / `log`（最后一个是诊断信道）

## 🔑 关键设计决策

### 1. 面板用原生 DOM，而不是 React 组件 + slot

这是踩坑后的结论。slots 实现里有一个「退位」机制：

```js
// dsh-client-ui-slots
// 条目因崩溃上报而退位后，会在本次注册生命期内被排除出 entriesOfSlot 投影
abdicated = new WeakSet()
```

即 **slot 条目的组件只要在渲染中抛一次异常，该注册就被永久退位**，再也不会渲染——
线上现象就是「点一下按钮就消失」。因此：

- 入口组件是**极简 React 按钮**（无 hooks / 无 Fragment / 无 Portal）
- 面板是**原生 DOM**，从点击处 `appendChild(document.body)`，全程 `try/catch`

附带好处：免疫 `overflow:hidden` 裁剪、外壳 `transform` 对 `fixed` 的干扰，
以及 `shell.overlay` 容器 `pointer-events:none` 的**继承**问题。

### 2. 恢复必须走 `workspaceRegistry`，绝不能直接改 `workspace.json`

`WorkspaceRegistry` 在内存里持有自己的 `state`，直改文件会被它下一次写入**覆盖**，
并触发启动时的一致性校验失败。正确做法是镜像 `archiveSession` 的写入协议：

```js
registry.enqueueOperation(async () => {
  const state = registry.requireState();
  if (!state.archivedSessionIds.includes(id)) return;
  await registry.setState({
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id),
  });
});
```

写入后会广播 `{type:'archived'}` 增量，浏览器侧**已经接好了**这个通道，所以侧边栏会自动把该行放回来。

> 为什么客户端不能自己 `open` 归档会话：`uiWorkspace.clearArchivedCurrent()` 订阅了 `sessions.list`，
> 会把任何选中归档会话的操作在下个微任务里回滚。**必须先在 host 侧把 id 移出归档集合。**

### 3. 会话文件是多帧 zstd，必须逐帧解码

会话存于 `<DSH_HOME>/sessions/<cwd 编码>/<sessionId>/session.jsonl.zstd`，
是**多个 zstd 帧拼接**的容器。Node 的 `zstdDecompressSync` 与流式解压**只解第一帧**，
所以 `archive-core.js` 复刻了 DSH 官方的 `scanZstdFrames` 结构扫描算法逐帧解码。

元数据来源（JSONL 记录）：

| 字段 | 来源 |
|---|---|
| 标题 | `session/title`（取最后一条） |
| 首条消息 | 第一条 `user/message` |
| 工作区 / 预设 | 头记录 `session` |
| 时间 | 记录 `time` |
| 消息数 | 统计 `user/message` + `assistant/message` |
| 岔出关系 | 头记录 `parentSession` |

### 4. 面板不透明化（对抗半透明主题）

`wallpaper-engine` 之类的插件会让主题背景变半透明，导致面板可读性变差。
本插件不直接使用主题色板，而是**自行解析出一套不透明配色**：
从框架文本色判断深/浅色，仅在框架背景已完全不透明时才复用它，否则回退到实色；
所有文字颜色均为显式值（不在半透明表面上叠 `opacity`），遮罩加深并加模糊。

## 🧪 测试

```bash
node tests/host_harness.js     # host HTTP 层（假 req/res + 模拟 registry）
node tests/client_harness.js   # 客户端交互（假 DOM + 假 fetch，真实执行 lib/client.js）
```

两个测试都不触碰真实归档数据：`restore` 的写入发生在模拟 registry 上。

## ⚠️ 已知限制

1. **岔出需要"已完成的回合"**：没有任何助手消息的会话会报 `session/fork-unavailable`（DSH 自身限制）。
2. **"引入当前对话"是尽力而为**：会话作用域事件未必跨作用域到达，故实现了三层降级，最差退化为复制到剪贴板。
3. **`workspaceRegistry` 的 `setState` / `requireState` / `enqueueOperation` 是 TS 私有但运行时公开的内部接口**
   （因为没有公开的取消归档 API）。升级 DSH 版本后建议回归验证。
4. **host 路由受 DSH 的令牌/来源守卫保护**，跨源访问会被拒绝（属预期行为）。

## 📄 License

MIT
