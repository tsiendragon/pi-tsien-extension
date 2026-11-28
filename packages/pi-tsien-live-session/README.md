# pi-tsien-live-session

把当前的 Pi 会话作为可远程接管的 live session 暴露给 dashboard：接管 / 释放、会话树导航、分叉、触发 reload；会话标题由 agent 设置；可按需导出「这个会话实际发给模型的内容」供 dashboard 做上下文分析。

## 工具

- `set_session_title`
- `sudo_exec`：绝对可执行路径 + argv + 可选绝对 cwd + 必填 `reason`（1–800 字符，用用户语言说明命令做什么、为何需 root、影响哪些服务/文件；不可只写“执行 sudo”或空泛保证安全）；需连接 Live bridge，由支持 `extension_ui.method=sudo` / `answer_sudo` 的新版 PiDash Android 单次授权。不要把密码放进工具参数或聊天。

## 命令

- `/dashboard-release`
- `/live-session-reload`
- `/ls-fork`
- `/ls-navigate`

## 事件钩子

`agent_end`、`agent_settled`、`agent_start`、`before_provider_request`、`extension_ui`、`extension_ui_notify`、`input`、`message_end`、`message_start`、`message_update`、`model_select`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_info_changed`、`session_shutdown`、`session_start`、`session_tree`、`thinking_level_select`、`tool_execution_end`、`tool_execution_start`、`tool_execution_update`、`turn_end`、`turn_start`

压缩期间（`session_before_compact` 到结束事件之间）dashboard / TUI 的输入会排在队列里，压缩结束后自动发送；状态随 `summary_update` 的 `compacting` 字段下发。

`before_provider_request` 只做观察：记下最后一次发给 provider 的载荷，供 dashboard 的只读 `get_context` 命令取用（照原样返回 `undefined`，不改写请求）。

## sudo 授权安全边界

新增 capability `sudo_approval`，无需改 pi 宿主。授权请求只发布随机 ID、主机、目录、完整 argv 的 JSON 字符串、用途说明（沿用 `message` 字段）和 120 秒期限；Android 5.13 先展示用途和可读命令，原始参数可展开。用途由 Pi 提供，不等于系统验证的安全结论；缺少用途说明的新请求在扩展端拒绝，旧请求在新版 App 中不得直接批准，需 `/reload` 本次源码后重新申请。专用 `answer_sudo` 只接收 ID 与 password 或 cancelled，不允许替换命令，首答胜出。普通 `answer_ui` 不会完成此请求。断开 bridge、session shutdown/start、工具 abort 或超时会取消尚未批准的请求。客户端请求结果不明时不能自动重试。

参数先于授权校验：防御运行时错误类型，拒绝未知字段/缺失或空白 reason、非绝对路径、NUL、超过 256 个参数或 16000 UTF-8 字节的输入。schema 无效输入由宿主先返回参数错误，扩展内校验失败返回带具体字段的 `invalid_sudo_parameters`，指示 agent 修正重试，不发布 `extension_ui`。预检仅做 stat/access：要求目标为 agent 用户可检查并执行的普通文件、cwd 可遍历且为目录，且 `/usr/bin/sudo` 已安装可执行（否则 `sudo_unavailable`）；不执行目标、不验证命令专用选项/解释器或 sudoers/PAM，不防 TOCTOU、不保证实际执行成功。参数在等待批准前复制并冻结。源码更新后必须由用户 `/reload`，工具 schema 必须包含必填 reason；不能只升级 App 或给旧请求补造说明。Android 5.27 对初始不完整或已过期的请求不显示授权密码框，仅尝试取消一次，失败只提示连接问题而不自动重试；旧宿主仍返回其原有取消错误；精确字段错误依赖新扩展。

执行使用 `/usr/bin/sudo -A -k -- executable ...args`，不解析 Shell、不重写 Bash sudo、不改 sudoers。密码仅在内存和 0700 临时目录内的一次性 Unix socket 传递给 askpass helper；helper 文件无密码，目标 stdin 为 `/dev/null`，包括 NOPASSWD 情况。与命令一起使用 `-k` 不复用/刷新 timestamp。临时目录必须允许执行 helper。需要可信 HTTPS Dashboard、可信宿主及扩展，反向代理不可记录请求体；不对同账户进程、root、内存/崩溃转储提供隔离保证，运行时字符串不保证可擦除。

只支持非交互 sudo/PAM 策略；需 TTY、多因素或多次交互时拒绝/失败，不降级至聊天输入密码。执行 120 秒后请求 SIGTERM，不保证所有 root 子进程终止或副作用撤销；输出只保留末尾 48000 字符。授权脚本意味着信任其当时内容；这是单次执行确认而非文件内容锁定/沙箱。测试使用假 sudo 执行器，不冒充真实提权或真机端到端验收。

部署时需同时更新 Dashboard 与 Android；当前源码实现不表示历史 npm 发布版已包含。按仓库扩展配置同步规范操作，再由用户 `/reload`；无需把 Dashboard 作为 root 运行。

## Proof jobs（只读）

Live Session 在发送会话快照后，经 Pi 事件总线发送 `pimatrix:proof-jobs:request`（`{ sessionId }`），并监听 pi-matrix 的 `pimatrix:proof-jobs:snapshot`（`{ sessionId, tasks }`）。仅接收当前会话的数据。

dashboard 收到 `live_feature_snapshot`，其 `data` 为 `{ feature: "proof-jobs", snapshot: { tasks } }`。每项仅包含 `id`、`label`、`state` 和可选的毫秒时间戳 `createdAt`、`startedAt`、`finishedAt`。快照替换整个列表；`tasks: []` 清空列表。切换会话不沿用旧列表，重连或 resync 会重新发布并请求最新快照。不提供 job 控制命令，协议仍为 v2.

## 配置

无（协议见 `src/protocol.ts`）

## 依赖

- 内部：`pi-tsien-shared`
- peer：`@earendil-works/pi-coding-agent`

## 说明

dashboard 侧入口 `/live-sessions`；依赖 `pi-tsien-shared`。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
