# Changelog

## Unreleased

- PTC 简化为始终可用的 `run_code` Code Mode：动态组合当前 active tools，移除 `/ptc` 模式切换和独立权限分层，嵌套调用统一复用 Pi 原生工具流水线。
- BTW 历史快照刷新键由 `Ctrl+R` 改为 `F5`，避免与自定义提交键冲突。
- 新增前台 Bash 命令区域，显示本地开始时间、耗时和最多 50KB 的实时输出尾部。
- 输入严格为空时可用方向键聚焦命令、切换输出和控制自动跟随。
- 通过 `pi-zero` 的 `pre-powerline v1` 插槽保持“命令 → Powerline → 输入框”，不覆盖现有 Powerline。
- 新增 4 个显式后台命令 Tool，支持立即返回任务 ID、查询状态、读取有限输出和整组取消；启动时可传人类可读标题。
- 后台日志按 Session 隔离，默认限制 1GiB；内存输出尾部限制 50KB，并在 Session 结束时清理。
- 前后台任务共享方向键列表和输出视图；完成摘要只进入下一次用户 Turn，不主动触发模型。
- 新增 `backgroundCommands.enabled` 回退开关，并支持同进程 `/reload` 任务重绑定。

## 0.3.0

- BTW 打开时继承主 Agent compact 后的当前有效 context。
- 新增只读 `session_history` 工具，按需搜索或分页读取 compact 前的完整活动分支历史。
- `Ctrl+R` 现在同时刷新当前 context 与完整 Session 历史快照。
- 历史查询结果仅在内存中截断，不写入临时文件或主 Session。

## 0.2.0

- 新增 `/btw` 临时侧聊浮窗。
- BTW 读取主 Agent 活动分支的历史快照，但使用独立内存会话。
- BTW 强制只启用 `read`、`grep`、`find`、`ls` 四个只读工具。
- 支持流式回答、取消、历史快照刷新和复制回答到主输入框。

## 0.1.0

- 集中管理 `git-graph` extension。
- 将会话信息侧栏重命名为 `sidebar`，并移除子代理与工作流展示。
- 集中管理 `context-powerline` extension。
