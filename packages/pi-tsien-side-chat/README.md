# pi-tsien-side-chat

与主任务隔离的**只读**侧聊浮窗：临时问一句而不污染主会话上下文；不能写文件、不能执行命令。

## 命令

- `/btw`：打开侧聊浮窗。关闭面板不会丢掉这次侧聊——再执行 `/btw` 会重开同一个会话，之前的问答仍可翻阅。
- `/btw <问题>`：打开（或重开）浮窗并直接提问。非交互式终端（dashboard / rpc）下没有浮窗，会把问题交给 dashboard 的 BTW 面板。

## 行为

- 每次提问前自动重新同步主会话上下文，不必手动按 `F5`；因此侧聊回答的是主任务「现在」的状态（与 Claude Code 的 `/btw` 一致，只是我们仍允许只读工具）。
- 只读工具：`read` / `grep` / `find` / `ls`，外加 `session_history`（翻被压缩掉的旧记录）。不能写文件、不能执行命令。
- 侧聊会话只在内存里（`SessionManager.inMemory`），不落盘；`session_shutdown` 或新的主会话（重载 / 清空 / resume）会丢弃它。
- 浮窗键位：`Enter` 发送（跟着你的 `tui.input.submit` 绑定走，比如改绑后就是 `Ctrl+R`／`F12`，浮窗底部会显示实际按键）· `Esc` 生成中取消、空闲时关闭 · `↑↓`/`PgUp`/`PgDn` 滚动 · `F5` 手动刷新主上下文 · `Ctrl+Y` 把最后一个回答送进主输入框 · `c`（输入框为空时）把最后一个回答以原始 Markdown 复制到剪贴板。

## 界面

浮窗是「三行表头 + 对话区 + 输入区」：

- 表头第一行 `BTW 只读侧聊 · 不改动主会话`；第二行 `只读 · <模型> · 主上下文 N 条（每次提问前自动同步）`；第三行是状态与滚动位置（`● 空闲`，生成中显示 `● 思考中 · 只读工具：read xxx`）。
- 底部按键提示只列出**当前真的能用**的键：生成中显示 `Esc 取消`，有回答后才出现 `c 复制回答`。
- 空状态直接说明能问什么（例如让它用 `read`/`grep`/`find`/`ls` 去查文件）。

## 事件钩子

`session_shutdown`、`session_start`（`session_start` 会丢弃上一个主会话遗留的侧聊）

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`（dashboard 桥接与 live feature）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
