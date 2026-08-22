# 子 PRD 4：与 pi-knowledge 协作

## 用户任务

> 我不想判断该搜 Memory 还是 Knowledge，Agent 应该自己找对地方。

## 两者边界

### pi-tsien-memory 负责

- 用户偏好；
- 已确认决策及理由；
- 跨 session 的任务连续性；
- 成功和失败经验；
- 从交互中学到的短、可修改记录；
- 记忆的更新、候选、遗忘和使用历史。

### pi-knowledge 负责

- 代码仓库、文档、PDF、DOCX、URL 和笔记的索引；
- 文件级增量更新；
- symbol、config、heading 查找；
- BM25、向量、混合检索和 rerank；
- KB 健康、staleness、导入导出；
- 保留来源 chunk 和文件路径。

### 明确禁止重叠

- Memory 不复制整个仓库、文档或工具输出；
- pi-knowledge 不替用户修改“我的偏好”；
- Memory 的遗忘不删除源代码或 Knowledge Base；
- Knowledge Base 更新不静默改写用户历史决策；
- 两者不各自向 prompt 注入重复内容。

## 自动路由

| 用户问题 | 默认路由 |
|---|---|
| “我以前怎么要求的？” | Memory |
| “上次为什么这么设计？” | Memory |
| “当前实现在哪个函数？” | pi-knowledge |
| “文档里怎么规定？” | pi-knowledge |
| “按之前决策检查当前实现” | 两者 |
| “这个报错之前遇到过且当前代码哪里触发？” | 两者 |

路由失败时允许一次有界 fallback，不进行无限搜索。

## 协作流程

```text
用户问题
  → QueryRouter
      ├─ MemorySearcher
      ├─ knowledge_symbol_search / knowledge_search
      └─ MixedResultMerger
  → 去重、冲突处理、统一 token budget
  → 临时 context
```

## 来源链接

Memory 可以保存指针：

```text
knowledge://<kb-id>/<chunk-id-or-hash>
file://<repo>/<path>@<commit>
session://<session-id>/<entry-id>
```

只保存短结论和指针，不复制 pi-knowledge chunk。来源失效时显示 stale，而不是假装仍然正确。

## 冲突规则

1. 当前代码、配置或正式文档描述“现在是什么”时，pi-knowledge 的新鲜来源优先；
2. Memory 描述“当时为什么做决定”时，不因代码变化而直接删除；
3. 当前来源反驳旧记忆时，将旧记忆标记为待更新；
4. 用户明确偏好与项目强制规则冲突时，强制规则优先，并解释冲突；
5. 无法判断时并列展示，不静默合并。

## 集成方式

### 第一阶段：松耦合

- 两个 extension 独立安装；
- 通过 Prompt 指引 Agent 选择对应工具；
- Memory 检测 `knowledge_*` 工具是否存在；
- 未安装 pi-knowledge 时 Memory 仍可独立工作。

### 第二阶段：共享路由协议

定义可选 extension event/service contract：

```text
knowledge:capabilities
knowledge:search-request
knowledge:search-result
memory:recall-request
memory:recall-result
```

协议只交换查询、结果和来源，不共享内部数据库。

### 第三阶段：复用检索基础设施

只有 pi-knowledge 提供稳定公共库接口后，Memory 才可选复用 Embedding/reranker provider。不能直接 import 私有 engine 或绑定其 SQLite schema。

## Prompt 注入协调

- 默认由一个 `ContextCoordinator` 统一预算；
- 如果 pi-knowledge 已开启 `PI_KNOWLEDGE_AUTO_INJECT`，Memory 应检测并避免重复注入；
- Memory 结果标记为 historical evidence；
- Knowledge 结果标记为 source evidence；
- 总预算而不是各自预算叠加。

## 验收标准

1. 用户无需知道两个系统的区别也能找到正确信息；
2. 未安装 pi-knowledge 时 Memory 功能不退化；
3. 同一源码片段不会同时以 Knowledge 和 Memory 正文重复注入；
4. 混合问题能同时返回历史决策与当前实现；
5. 当前源码变化能触发旧 Memory 的 stale 提示；
6. 两个扩展不会争抢或覆盖彼此的数据目录。
