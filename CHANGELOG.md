# Changelog

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
- 集中管理 `subagent-sidebar` extension。
- 集中管理 `context-powerline` extension。
