# pi-tsien-memory PRD

- **版本**：0.2
- **状态**：Draft
- **定位**：Pi 的用户记忆层，而不是另一个文档知识库

## 1. 一句话说明

用户正常与 Pi 工作，`pi-tsien-memory` 自动沉淀稳定知识，在后续任务中自动找回相关内容；用户只在纠错、遗忘或确认高风险知识时介入。

## 2. 为什么重做

旧版 PRD 按“写入、更新、遗忘、搜索”组织，更像存储系统设计，而不是用户产品。

真实用户通常不会：

- 主动给每条知识分类；
- 记住 Memory ID；
- 每次都执行 `/memory remember`；
- 定期手工整理数据库；
- 区分 BM25、Vector 或 revision。

Pi 与 Codex 的会话习惯表明，用户更期待：

1. 会话自动保存；
2. 回到同一项目时自动恢复上下文；
3. 上下文过长时自动压缩；
4. 需要时再查看、分支、归档或删除；
5. Agent 自己找到与当前任务有关的信息。

因此，Memory 的默认体验也应是自动化、低打扰、可撤销。

## 3. 用户最终体验

### 日常使用

用户照常说：

> 这个项目以后都用 pnpm，不要再建议 npm。

Agent 正常回答，并在末尾轻量提示：

> 已记住：本项目使用 pnpm。`撤销` · `查看`

下一次新 session 中，用户直接说：

> 帮我安装依赖。

Agent 自动召回该偏好，直接使用 pnpm，不要求用户重复说明。

### 纠错

用户说：

> 之前那个 Node 20 的记录过时了，现在用 Node 22。

Agent 自动找到对应记忆、更新并说明变化，不要求用户查 ID。

### 遗忘

用户说：

> 忘掉我刚才说的临时测试账号。

Agent 找到相关记忆，展示将遗忘的内容并确认；完成后不再召回。

## 4. 产品边界

| 系统 | 负责什么 | 不负责什么 |
|---|---|---|
| Pi/Codex session | 当前会话原始历史、恢复、分支、压缩 | 跨会话稳定知识治理 |
| pi-tsien-memory | 从交互中学到的偏好、决策、经验、历史上下文 | 索引整个代码库、PDF、URL |
| pi-knowledge | 对现有文件、代码、文档、网页建立可更新索引 | 判断用户偏好、修改个人记忆 |
| eagleeye-knowledge | 经审查、可复用、可追踪的组织知识条目 | 自动安装执行能力 |
| EagleEye Marketplace | 可版本化、可安装、可测试的 rule/skill/hook/agent/plugin | 保存个人临时记忆 |

关键原则：

> Session 是经历，Memory 是从经历中学到的内容，Knowledge 是有来源的事实，Marketplace 是可安装的能力。

## 5. 最核心的三个能力

### P0-1 自动沉淀

- 明确表达“记住、以后、不要再”时直接保存；
- 已确认决策、稳定偏好、验证成功的经验可自动保存；
- 不确定内容只成为候选，不影响后续回答；
- 保存后只给一行提示，并允许立即撤销。

详见：[任务 1](prd/01-daily-capture.md)。

### P0-2 自动召回

- 每轮开始时，根据当前问题、项目和分支自动寻找相关记忆；
- 只注入少量高相关内容；
- 不重复注入当前 session 已经存在的信息；
- 用户可以问“你为什么这么做”，看到召回依据。

详见：[任务 2](prd/02-auto-recall.md)。

### P0-3 自然语言纠错与遗忘

- 用户不需要知道 ID；
- 支持“刚才那条”“关于 pnpm 的记录”等自然指代；
- 更新、遗忘和撤销必须可解释；
- 敏感内容优先遗忘并验证不可召回。

详见：[任务 3](prd/03-user-control.md)。

## 6. 用户不需要的功能

首版不做：

- 让用户手工选择 semantic/episodic/procedural；
- 复杂记忆管理后台；
- 知识图谱；
- 团队实时同步；
- 对每个候选逐条弹窗确认（仅在有 UI 的 Pi 会话中，可关闭或稍后处理）；
- 要求用户维护 Memory ID；
- 默认远程 Embedding；
- 自动生成并发布 Marketplace plugin；
- 将完整日志、代码或文档复制进 Memory。

高级搜索算法可以后续替换，但不能改变用户交互。

## 7. 默认自动化策略

| 情况 | 默认行为 | 是否打扰用户 |
|---|---|---|
| 用户明确要求记住 | 立即保存 | 一行提示，可撤销 |
| 用户确认长期偏好或决策 | 自动保存 | 一行提示，可撤销 |
| 工具验证出可复用经验 | 建立候选并在有 UI 时弹出审核 | 用户选择接受、拒绝或稍后处理 |
| 猜测、临时状态、未验证结论 | 不保存 | 不提示 |
| 敏感信息 | 拒绝保存或立即隔离 | 明确提示 |
| 新 session 需要旧知识 | 自动召回 | 默认静默，可查看 |
| 记忆与当前源码冲突 | 以当前来源为准，标记记忆待更新 | 必要时提示 |
| 可能晋升组织知识或插件 | 只生成建议和证据 | 用户确认后再进入外部流程 |

## 8. 与 pi-knowledge 协作

两者可以同时安装，但不互相复制数据。

- “我上次为什么选 SQLite？”优先搜索 Memory；
- “当前代码如何初始化 SQLite？”优先搜索 pi-knowledge；
- “按之前的决策检查当前实现”同时搜索两者；
- Memory 保存 pi-knowledge 来源指针，不复制整段源码；
- 当前源码与旧记忆冲突时，源码事实优先，旧记忆进入更新候选。

详见：[任务 4](prd/04-pi-knowledge-collaboration.md)。

## 9. 从个人记忆到 Marketplace

不是每条知识都应该成为 plugin。

```text
一次对话
  → 个人 Memory
  → 多次复用的知识候选
  → eagleeye-knowledge 条目
  → Rule 或 Skill
  → 多组件协作时才成为 Plugin
```

Memory extension 只负责发现模式、整理证据和生成草案建议；正式写入、评审、版本化、安装和发布由 eagleeye-knowledge 与 EagleEye Marketplace 流程负责。

详见：[任务 5](prd/05-marketplace-promotion.md)。

## 10. 成功标准

首个可用版本应证明：

1. 用户无需手工命令，也能让稳定偏好跨 session 生效；
2. Agent 能在正确任务中召回，而不是每轮都塞入全部记忆；
3. 用户一句自然语言即可纠错或遗忘；
4. 不同 repository、branch 和用户之间不会串记忆；
5. 不重复存储 pi-knowledge 已索引的代码和文档；
6. 自动捕获的错误知识不会直接污染后续回答；
7. 所有自动行为都有来源、理由和撤销路径。

## 11. 子 PRD

1. [日常知识自动沉淀](prd/01-daily-capture.md)
2. [自动召回并注入上下文](prd/02-auto-recall.md)
3. [查看、纠正与遗忘](prd/03-user-control.md)
4. [与 pi-knowledge 协作](prd/04-pi-knowledge-collaboration.md)
5. [知识晋升到 EagleEye Marketplace](prd/05-marketplace-promotion.md)
6. [交付阶段与可替换模块](prd/06-delivery-plan.md)

## 12. Tech Design

具体架构、数据模型、状态机、Pi 事件接入和实施顺序见：[Tech Design](TECH_DESIGN.md)。

## 13. 参考行为

- Pi session：自动持久化、项目维度恢复、树分支、自动 compaction、extension `context` 临时注入；
- Codex CLI 0.146：默认按当前工作目录筛选 session，可 resume、fork、archive、delete；
- pi-knowledge：索引已有文件并跨 session 检索，支持可选 context auto-injection；
- EagleEye Marketplace：Skill、Rule、Hook、Agent、Plugin 有独立职责，Plugin 只用于多组件协作，Pi adapter 要求明确兼容声明和 reviewed adapter。
