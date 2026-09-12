# dsh-archive-browser

浏览 **DeepSeek Harness (DSH)** 中已归档的会话，并对其执行"再调用"。

> **背景**：DSH 的「归档」是**单向**操作——官方只有 `archiveSession`，**没有任何取消归档的入口**，
> 且归档后的会话会被界面从所有列表里过滤掉（`sessionVisible` 中的 `!archived.has(id)`）。
> 本插件补上了这块能力：把归档会话重新"捞"出来看、恢复、引用、续聊。

[![DSH](https://img.shields.io/badge/DSH-plugin-4b6bfb)](https://github.com/anywhere-labs/deepseek-harness-desktop)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## ✨ 功能

侧边栏底部会出现一个 **🗄 已归档** 按钮，点开面板后，每个归档会话提供五项操作：

| 操作 | 说明 | 实现方式 |
|---|---|---|
| **查看内容** | 面板内渲染对话转录，**按角色上色**：▎你（蓝）· ▎助手（绿）· ▎工具（灰，紧凑等宽并显示"它干了什么"） | host 读取并逐帧解码会话文件 |
| **影响面** | **只读**体检：这个会话在你的电脑上动过哪些文件、跑过哪些命令、派生出了哪些会话 | host 解析 `tool/call` + `tool/result` |
| **恢复到侧边栏** | 从归档集合移除，会话重新出现在左侧列表（**无需刷新**） | 写 `workspaceRegistry`，触发官方增量广播 |
| **引入当前对话** | 把归档内容整理成 digest 写入当前输入框 | `conversation` 服务 → `slash/input-insert-text` 事件 → 剪贴板（三层降级）|
| **岔出继续对话** | 从归档会话岔出一个新的活会话并打开 | `sessions.fork({ increaseTitle: true })` |

列表显示：**标题、最后活动时间、工作区、消息数（用户/助手）、首条消息预览**，以及岔出关系。

> **默认顺序是「最近活动↓」**（最近用过的排最上面）。顶部有「**顺序**」按钮，点一下换一种排法：
> **最近活动↓ → 最近活动↑ → 归档顺序 → 标题**，选择会记住（下次打开还是它）。
> 排序在客户端完成，**不会再去读一次归档**。
>
> **打开面板是"轻量载入"**：每行只读 DSH 自己的投影缓存（标题 / 首条消息 / 时间）+ 一次 stat，
> **不解压任何转录**（实测 9 个归档会话：**4ms** vs 逐个解压 333ms）。
> 消息数（"N 用户 / M 助手"）不在轻量数据里 —— **点开那个会话**（查看内容 / 影响面）后才会补到那一行。

### 🔍 「影响面」是什么

点开每个归档会话的「影响面」，会得到一份**只看不改**的清单 —— 用来判断"这段对话到底在电脑上留下了什么"：

| 区块 | 显示什么 |
|---|---|
| **产出 / 修改的文件** | 路径、**新建还是修改**、**现在还在不在**、大小、最后修改时间、被改过几次 |
| **执行过的命令** | 按 **安装依赖 / 克隆仓库 / 下载 / 其它** 分类高亮，附命令自带的描述与失败标记 |
| **派生出去的会话** | **小助手（子代理）** 与 **分支（fork）** 分开标注 —— 分支在左侧列表里本来就看得见 |

每一步都有**大白话解释**，而且是**根据每条的实际状态生成**的（不是同一句套话）。

**只读保证**：不修改任何数据；文件只做"还在不在 / 多大 / 什么时候改的"三项检查，不读文件内容。

> ⚠️ **依赖不会被自动卸载。** 面板只列出"这段对话装过什么、下载过什么"，是否清理由你决定 ——
> 一个软件包可能别的会话或别的程序正在用，乱删会把其它东西弄坏。

> 数据来自哪里：转录里的工具调用参数是**无损记录**的（DSH 宁可抛错也不截断），所以
> `write` / `edit` 动过哪些文件、`pwsh` 跑过哪些命令都能可靠重建；"新建 vs 修改"取自 `write`
> 结果里的 `Created file` / `Updated file` 标记。

## 📦 安装

### 方式一：从 GitHub 下载（**现在就能用**）

1. **下载 ZIP**：[`codeload.github.com/.../zip/refs/heads/main`](https://codeload.github.com/liyu1314-lmyc/dsh-archive-browser/zip/refs/heads/main)

   （或在仓库页 Code → Download ZIP。注：部分网络下 `github.com` 网页打不开，但上面这个直链可以。）

2. **解压后**把顶层目录 `dsh-archive-browser-main` **改名并放进**：

   ```
   <DSH_HOME>\profiles\desktop\node_modules\dsh-archive-browser\
   ```

   `<DSH_HOME>` 默认是 `C:\Users\<你的用户名>\.dsh`。
   放好后该目录里应该直接能看到 `package.json`、`lib\`、`cordis.patch.yml`。

3. **在该 profile 的 `cordis.patch.yml` 里追加**：

   ```yaml
   - insert:
       - id: archive-browser
         name: 'dsh-archive-browser'
   ```

   （这个文件默认内容可能只是一行 `[]` —— 如果有 `[]`，把它替换成上面的内容；如果已有其它条目，就追加到数组里。）

4. **重启 DSH Desktop**。侧边栏底部就会出现 **🗄 已归档**。

> 第 4 步不能省：host 半的 HTTP 路由要在启动时挂载。不重启的话，点「影响面」会报
> `unknown archive api method "impact"`。

### 方式二：官方 CLI（**需要先发布到 npm**）

```powershell
dsh plugin --profile desktop add dsh-archive-browser
```

> ⚠️ 本包**尚未发布到 npm**（截至 2026-09-11，`registry.npmjs.org/dsh-archive-browser` 返回 404），
> 所以这条命令现在会报"找不到包"。发布到 npm 之后它会自动完成上面第 2~3 步。

### 🔧 改代码之后要不要重启？

> - 改 **client 半（`lib/client.js`）**：被 `dsh-client-hmr` 自动热重载，**不必重启、不必刷新**。
> - 改 **host 半（`lib/index.js` / `lib/archive-core.js`）**：**需要重启 DSH**
>   （实测：只改 host 文件不会自动重载，等 30 秒也不会）。
> - **首次安装后也要重启一次** —— host 半的 HTTP 路由要挂载，否则点「影响面」会报
>   `unknown archive api method "impact"`。

## 🧱 架构

```
lib/archive-core.js   host 纯逻辑：定位会话文件、多帧 zstd 解码、元数据提取、转录
lib/index.js          host 插件入口：Cordis apply + webServer 路由
lib/client.js         client UI：极简 React 入口按钮 + 原生 DOM 面板
cordis.patch.yml      挂载声明（insert 行）
tests/                离线测试（假 DOM / 假 req-res / 模拟 registry）
```

**host 路由**：`POST /archive-browser/api/<method>`
`list` / `read` / `impact` / `restore` / `log`（最后一个是诊断信道）

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
