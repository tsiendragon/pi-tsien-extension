# 子 PRD 6：交付阶段与可替换模块

## 原则

按用户价值交付，而不是先完成一套复杂 Memory 平台。

## Phase 1：能自动记住，也能自动想起

范围：

- 明确记忆和高置信度偏好捕获；
- active / candidate 两种状态；
- repository / branch / global scope；
- 自动召回与临时 context 注入；
- 一行提示、撤销；
- 自然语言查看、纠正和遗忘；
- 本地存储和 secret filter。

首版内部能力仍包括 Write、Update、Forget、Search，但它们不直接定义用户界面。

退出条件：用户在不同 session 中无需重复稳定偏好，且能一句话纠错或遗忘。

## Phase 2：降低误记和误召回

范围：

- 候选重复验证与晋升；
- 来源链和“为什么召回”；
- 冲突、stale 和 supersedes；
- compaction、resume、fork 行为完善；
- 召回诊断和质量指标；
- 自动沉淀开关与批量 review。

退出条件：错误候选不会进入 prompt，旧事实不会覆盖当前事实。

## Phase 3：与 pi-knowledge 协同

范围：

- QueryRouter；
- Memory / Knowledge 双通道路由；
- 混合结果去重和统一 token budget；
- knowledge 来源指针；
- 可选共享事件协议；
- pi-knowledge 未安装时的独立运行。

退出条件：用户无需选择搜索工具，且代码正文不被重复保存为 Memory。

## Phase 4：知识晋升

范围：

- 复用次数和结果记录；
- eagleeye-knowledge 候选包；
- Rule / Skill / Plugin 分类建议；
- 脱敏、反例和适用范围检查；
- 只读 Marketplace preflight；
- 用户确认后交给现有开发流程。

退出条件：系统能提出高质量草案，但不会自动修改或发布外部包。

## 可替换模块

```text
CaptureDetector        是否值得沉淀
MemoryExtractor        如何生成短记忆
MemoryStore            如何持久化和更新
SearchBackend          如何召回候选
RecallRanker           如何排序和门控
ContextBudgeter        如何控制 prompt 成本
KnowledgeBridge        如何连接 pi-knowledge
PromotionAdvisor       如何判断知识晋升
SecretFilter           如何识别敏感内容
```

每个模块都通过稳定输入输出协议连接。替换算法不得改变：

- 用户自然语言入口；
- scope 隔离；
- 来源与撤销；
- candidate 不自动注入；
- 遗忘后不可正常召回；
- 外部发布必须确认。

## 首版不锁定的技术

以下实现留到技术设计阶段决定：

- SQLite 具体 schema；
- FTS5 或 Vector 的组合；
- Embedding 模型；
- LLM 提取 prompt；
- 评分公式；
- UI 组件形态。

## 关键指标

### 用户价值

- 用户重复说明同一偏好的次数；
- 有用记忆自动召回率；
- 用户纠正或撤销率；
- 自动候选被接受率；
- 用户主动执行 Memory 命令的次数，应随自动化提升而下降。

### 质量与安全

- 无关记忆注入率；
- stale 记忆影响回答的次数；
- 跨 repository / branch 泄漏数；
- secret 进入正文、Embedding 或日志的数量；
- 遗忘后仍可召回的数量；
- Prompt Injection 被晋升为指令的数量。

### 成本

- 每轮 Memory 注入 token；
- 自动搜索 P95 延迟；
- 捕获和召回失败是否阻塞主任务；
- 与 pi-knowledge 同时启用时的重复上下文比例。

## 第一版产品决策

- 自动沉淀默认开，但只自动激活明确记忆和高置信度偏好；
- 自动召回默认开；
- 远程处理默认关；
- global memory 默认只接受用户明确偏好；
- 候选默认不注入；
- 图数据库、团队同步和自动 Plugin 发布不进入第一版。
