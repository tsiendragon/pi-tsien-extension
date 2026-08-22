# Tech Design: 历史窗口渲染

> PRD: docs/prd/transcript-window.md
> 状态: APPROVED
> 目标版本: pi-zero 0.3.0（计划）

## 方案概述

在 pi-zero 中新增“历史窗口”模块。它只影响 Pi TUI 的转录构建：默认保留最新 20 个以用户消息开始的对话轮次，把更早轮次在 Pi 创建消息、工具和思考组件之前过滤掉，并在可见内容前插入一条折叠提示。会话 JSONL、SessionManager 和发送给模型的上下文均不改写。

Pi 0.84.1 已公开导出 InteractiveMode，但没有公开的转录过滤 API。本方案以受保护的原型补丁包装 InteractiveMode.renderSessionItems：这是现有 ccstyle 已采用的兼容策略，但会为运行时结构检查、单一所有者和安全回退设置边界。

## 架构设计

~~~mermaid
flowchart LR
  A[SessionManager 与完整会话数据] --> B[buildContextEntries]
  B --> C[InteractiveMode.renderSessionEntries]
  C --> D[pi-zero 转录窗口补丁]
  E[全局和项目 settings.json] --> F[配置解析器]
  G[/transcript 命令] --> H[会话级视图状态]
  F --> H
  H --> I[轮次选择器]
  D --> I
  I -->|旧轮次| J[一条折叠提示]
  I -->|可见轮次| K[Pi 原始 renderSessionItems]
  J --> L[chatContainer]
  K --> L
  L --> M[ScrollView 与终端画面]
~~~

## 模块划分

| 模块 | 职责 | 文件路径 |
|------|------|---------|
| 配置解析 | 读取全局/项目设置，字段级合并、校验并提供默认值 | transcript-window/config.ts |
| 轮次选择器 | 纯函数：按 user 消息划分轮次、选择后缀并产出折叠统计 | transcript-window/turns.ts |
| 会话控制器 | 保存当前进程的展开/折叠/临时轮次状态，生成状态文本并请求重建 | transcript-window/controller.ts |
| Pi 渲染补丁 | 包装 InteractiveMode.renderSessionItems，插入折叠提示后调用原实现 | transcript-window/interactive-patch.ts |
| 扩展入口 | 注册命令、订阅生命周期、安装与卸载补丁 | transcript-window/index.ts |
| 现有入口 | 在 piZero 初始化期间安装历史窗口模块 | index.ts |
| 测试 | 覆盖配置、轮次选择、命令状态和补丁回退 | test/transcript-window.test.mjs |
| 文档与发布 | 配置说明、变更说明和版本 | README.md、CHANGELOG.md、package.json |

## 接口定义

### TranscriptWindowConfig

输入：全局 ~/.pi/agent/settings.json 与项目 .pi/settings.json 的 transcriptWindow 字段。

输出：已校验的不可变配置。

~~~ts
type TranscriptWindowConfig = {
  enabled: boolean;
  recentTurns: number;
  hideHistoricalTools: boolean;
  hideHistoricalThinking: boolean;
};

const DEFAULT_TRANSCRIPT_WINDOW: TranscriptWindowConfig = {
  enabled: true,
  recentTurns: 20,
  hideHistoricalTools: true,
  hideHistoricalThinking: true,
};
~~~

规则：

- 先读取全局对象，再以项目对象的同名字段覆盖；项目只配置 recentTurns 时不丢失全局其他字段。
- enabled、hideHistoricalTools、hideHistoricalThinking 只接受 boolean。
- recentTurns 只接受 1 到 200 的有限整数；其他值回退 20。
- 设置文件不存在、JSON 无法解析或 transcriptWindow 不是对象时安全使用默认值。

### selectTranscriptWindow

输入：Pi 即将交给 renderSessionItems 的消息/自定义条目数组，和当前有效可见轮次数。

输出：可见后缀、被折叠的用户轮次数，以及是否应显示提示行。

~~~ts
type TranscriptSelection<T> = {
  visibleItems: readonly T[];
  hiddenTurns: number;
};
~~~

算法：

1. 找出 role 为 user 的消息下标；每条用户消息开始一个轮次，直到下一条用户消息前的 assistant、toolResult 和 custom 条目属于该轮次。
2. 窗口关闭、处于展开状态、或总轮次数不超过上限时返回完整数组。
3. 否则从倒数第 recentTurns 条用户消息开始截取后缀；截取前的所有条目不调用 Pi 原始渲染器。
4. 因此被折叠轮次的用户、助手、工具、思考和相关自定义条目都不会创建 TUI 组件；提示行只使用 hiddenTurns。
5. 没有用户消息的异常/启动序列完整保留，避免隐藏 Pi 自己的启动或诊断内容。

正在执行的轮次以最近一条用户消息开始，必然属于后缀，因此始终可见。

### TranscriptWindowController

输入：解析后的配置、生命周期事件和 /transcript 子命令。

输出：effectiveRecentTurns、状态提示和一次安全的转录重建请求。

~~~ts
type TranscriptViewMode = "follow-config" | "expanded" | "collapsed";

type TranscriptWindowStatus = {
  mode: TranscriptViewMode;
  effectiveRecentTurns: number | null;
  hiddenTurns: number;
};
~~~

状态规则：

- 新建、恢复、切换或 reload 后均重置为 follow-config；配置缺省时等效于折叠并显示最近 20 轮。
- expand 只将本进程当前会话置为 expanded，不写设置和 session。
- collapse 清除临时覆盖，回到 follow-config；若配置 enabled 为 true 则重新折叠，否则保持完整可见。
- turns N 将当前会话置为 collapsed，且 N 仅在本 Pi 进程存活期间有效。
- status 只报告当前有效状态，不改变视图。
- 成功操作用 ctx.ui.notify 反馈；无有效 TUI 实例时仍更新状态，下一次 Pi 重建时生效。

### /transcript 命令

输入：status、expand、collapse 或 turns <n>。

输出：当前状态或用法错误提示。

| 子命令 | 行为 |
|------|------|
| /transcript 或 /transcript status | 显示开启状态、可见轮数和已折叠轮数 |
| /transcript expand | 当前进程显示全部历史 |
| /transcript collapse | 清除临时展开并恢复配置决定的窗口 |
| /transcript turns <n> | 当前进程显示最近 n 轮，n 必须为 1 到 200 的整数 |

未知子命令或非法 n 不改动现有状态，并显示用法。

### InteractiveMode 原型补丁

输入：原始 renderSessionItems(items, options)。

输出：在原方法前插入一条 Text 折叠提示，并将仅含窗口后缀的 items 传给原方法。

实现约束：

- 使用 @earendil-works/pi-coding-agent 公开导出的 InteractiveMode；私有方法与 chatContainer 仅经最小 any 适配层访问。
- 仅当 renderSessionItems 是函数、chatContainer 具备 addChild 且 ui 可请求渲染时安装。检查失败时不改变原型，Pi 保持原生完整转录。
- 使用 Symbol.for 保存唯一补丁所有者。reload/重复安装先恢复仍由自己持有的包装；卸载只在原型仍指向本包装时恢复，避免覆盖后加载扩展。
- 折叠提示采用普通 Text 和一个 Spacer，不写入 session entry，也不参与模型上下文。
- 配置的 hideHistoricalTools 与 hideHistoricalThinking 默认均为 true。完全被窗口排除的轮次始终不会泄漏任何内容；这两个字段用于兼容 Pi 重建/其他渲染补丁可能重放旧工具或思考组件的场景，false 不会破坏“单条折叠提示”的完整性。
- 切换命令通过已捕获的 InteractiveMode 实例调用 rebuildChatFromMessages；此方法会清空 chatContainer 后再次走窗口补丁。若该内部方法不可用，只请求渲染并提示兼容性降级，不影响当前会话和模型。

## 数据模型

~~~ts
type TranscriptWindowRuntime = {
  config: TranscriptWindowConfig;
  viewMode: TranscriptViewMode;
  temporaryTurns?: number;
  activeMode?: {
    rebuildChatFromMessages?: () => void;
    renderSessionItems?: Function;
    chatContainer?: { addChild(component: unknown): void };
    ui?: { requestRender(): void };
  };
  lastHiddenTurns: number;
};
~~~

所有运行时状态保存在扩展内存和全局补丁所有者中，不能写入 settings.json、session JSONL 或 ExtensionAPI 的 custom entry。

## 生命周期与兼容顺序

1. piZero 初始化时安装转录窗口补丁并注册命令，确保首次 renderInitialMessages 前已有包装。
2. session_start 读取当前 cwd 的设置，清除会话级临时状态；Pi 在该事件之后才执行首次 renderInitialMessages。
3. session_compact、恢复、分支切换和 /reload 触发的重建继续经过同一个包装。session_compact 不丢失当前进程的临时 expand/turns 选择。
4. agent_settled 在用户轮次刚超过窗口时按需重建，避免 Pi 的增量追加使已完成的旧轮次留在画面上。
5. session_shutdown 停止本安装并在仍拥有原型时恢复；后续 reload 的新安装重新接管。
6. ccstyle 继续拥有 AssistantMessageComponent、ToolExecutionComponent 与 UserMessageComponent 的外观补丁。历史窗口位于组件创建之前，因此不会与其内部子组件替换竞争。

## 实现步骤

| 步骤 | 描述 | 负责方 | 预估 |
|------|------|--------|------|
| 1 | 新建配置解析器和纯轮次选择器，并用 node:test 覆盖边界 | pi-zero | 0.5 天 |
| 2 | 实现会话控制器与 /transcript 命令，接入 session_start/session_compact | pi-zero | 0.5 天 |
| 3 | 实现带所有权保护和运行时降级的 InteractiveMode 补丁 | pi-zero | 0.5 天 |
| 4 | 将模块接入 index.ts，验证与 ccstyle、compact-thinking、powerline 的共存 | pi-zero | 0.5 天 |
| 5 | 更新 README、CHANGELOG、版本与手工验证记录 | pi-zero | 0.25 天 |

## 测试与验证

自动化测试采用 Node 内置测试运行器配合仓库已依赖的 jiti/register 加载 TypeScript：

~~~text
node --import jiti/register --test test/transcript-window.test.mjs
~~~

覆盖范围：

- 缺省、全局、项目覆盖和非法 transcriptWindow 配置。
- 0、1、20、21 及大量轮次的选择结果；工具结果和 custom 条目不能在隐藏范围泄漏。
- 当前轮次、没有 user 消息、连续用户消息和展开状态。
- expand、collapse、turns <n> 的进程内状态转换与非法参数不变性。
- 原型补丁缺少目标方法时不抛错且保持原渲染器。
- reload/多次安装时只保留一个包装并可正确恢复上游包装。

手工 TUI 验证：

1. 用超过 25 轮、含工具调用和思考块的 session 启动或 /resume，确认只见一条折叠提示和最新 20 轮。
2. 依次执行 expand、collapse、turns 5、status，确认每次即时重绘且重启后临时状态消失。
3. 执行 /compact、/reload、窗口缩放和会话切换，确认无重复、空白、乱序或滚动跳转。
4. 切换 /ccstyle 与工具/思考展开状态，确认最近窗口内的现有外观不回退。
5. 对比 session 文件哈希和模型上下文条目数量，确认仅 TUI 展示变化。

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| Pi 改动 InteractiveMode 私有方法或容器字段 | 中 | 历史窗口不可用 | 运行时形状检查、一次性兼容提示、回退原生完整转录；测试锁定支持版本 |
| 上游/其他扩展重包同一方法 | 中 | 包装顺序或卸载互相覆盖 | Symbol 所有者、只恢复自身包装、保存前一层函数 |
| Pi 重建时出现工具/思考残留 | 低 | 旧内容泄漏 | 在组件创建前过滤整个轮次；命令切换强制 rebuildChatFromMessages |
| 长会话仍需扫描 session 条目 | 高 | 不能消除所有 CPU 开销 | 目标是减少 Markdown、工具、图片和组件构造；不声称缩短模型上下文构建 |
| 命令在流式执行中触发重建 | 低 | 当前流式组件可能受影响 | 命令先检查 ctx.isIdle；忙碌时拒绝并提示等待完成 |

## 验收标准

- [ ] 不配置 transcriptWindow 时，超过 20 轮的会话只显示最近 20 轮、当前轮次和一条折叠提示。
- [ ] 配置 enabled: false 后，未执行临时命令时完整历史可见。
- [ ] 全局与项目设置按字段合并，非法值安全回退。
- [ ] expand、collapse 和 turns <n> 不修改 session 或模型上下文，且在本进程立即生效。
- [ ] 被折叠轮次不会构造用户、助手、工具或思考组件；ccstyle 的可见窗口行为不变。
- [ ] /resume、/compact、/reload、切换会话和窗口缩放后结果正确。
- [ ] 自动化测试通过，README、CHANGELOG 和 package.json 版本同步更新。
