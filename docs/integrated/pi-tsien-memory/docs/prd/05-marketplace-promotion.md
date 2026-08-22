# 子 PRD 5：知识晋升到 EagleEye Marketplace

## 用户任务

> 当一条经验反复有用时，希望系统提醒我把它变成团队可复用的规则或工具，但不要擅自发布。

## 沉淀阶梯

```text
Session 事件
  → Personal Memory
  → 可复用知识候选
  → eagleeye-knowledge 条目
  → Rule / Skill / Agent / Hook
  → 多组件协作时才是 Plugin
```

每一级解决不同问题，不能跳级自动发布。

## 什么时候仍然只是 Memory

满足任一条件就保留为 Memory：

- 只对一个用户有意义；
- 只出现过一次；
- 尚未验证；
- 依赖当前 session 的临时状态；
- 包含私人路径、账号或未脱敏数据；
- 只是“我喜欢怎样工作”；
- 没有可描述的输入、输出和成功标准。

## 什么时候建议进入 eagleeye-knowledge

适合形成知识条目：

- 在至少两个独立任务中被验证或复用；
- 有明确现象、原因、决策或解决方式；
- 能附来源和适用范围；
- 已去除个人敏感信息；
- 对未来 Agent 或其他成员有帮助；
- 仍以“知识”而非“自动执行能力”为主。

建议映射：

| 内容 | eagleeye-knowledge 类型 |
|---|---|
| 用户或团队偏好 | UP |
| 错误现象与解法 | EI |
| 应避免的错误路径 | WP |
| 可复用代码模式 | CP |
| 技术选择和理由 | TD |
| 内部业务事实 | BK |

Memory extension 只生成候选摘要、来源、复用次数和适用范围，由知识沉淀流程负责评审和写库。

## 什么时候成为 Marketplace 组件

### Rule

适合始终生效的短约束：

- 触发条件清楚；
- 几乎没有参数；
- 违反后果明确；
- 跨多次任务稳定成立。

独立通用 Rule 应单独发布，不为了包装而创建 Plugin。

### Skill

适合用户或 Agent 按需调用的工作流：

- 有清晰输入、步骤、输出；
- 已成功重复执行；
- 能写出验收标准；
- 不需要常驻生命周期拦截。

### Agent

适合独立角色和受限调查任务。是否发布为 Agent 需要单独设计和运行时兼容评审，Memory 不自动决定。

### Hook / Pi Extension

适合在 session、input、tool 或 agent lifecycle 自动触发的行为。必须经过安全和失败策略评审，尤其是权限、阻断和外部副作用。

### Plugin

只有在两种以上组件必须协作时才建议 Plugin，例如：

```text
Skill + Rule
Skill + reviewed Hook
Rule + Agent + Extension
```

单条知识、单条 Rule 或单个 Skill 不应包装成 Plugin。

## 提议晋升的最低证据

系统可以在以下条件同时满足时给出建议，不自动执行：

1. 至少 3 次成功使用；
2. 覆盖至少 2 个独立任务，跨项目能力还需覆盖不同项目；
3. 没有未解决反例或明显冲突；
4. 用户确认其具有复用价值；
5. 可以说明适用范围和不适用范围；
6. 能形成测试、示例或可检查的结果；
7. 已脱敏；
8. 有明确维护者。

次数只是触发建议，不是质量证明。

## 用户体验

低频提示：

```text
这条经验已在 3 个任务中成功复用，可能适合沉淀为 Skill。
查看证据 · 生成草案 · 暂不提醒
```

生成草案时输出“晋升包”：

- 建议类型：knowledge / rule / skill / plugin；
- 用户问题和适用场景；
- 已验证步骤；
- 来源任务与使用次数；
- 反例和限制；
- 脱敏后的示例；
- 建议验收测试；
- Marketplace 组件建议。

## 与 Marketplace 的边界

Memory extension 可以：

- 发现重复模式；
- 统计成功复用；
- 生成脱敏草案；
- 调用现有 Marketplace 开发入口前请求用户确认。

Memory extension 不可以：

- 直接修改 `eagleeye-ai-dev`；
- 自动创建、提交或发布包；
- 自动决定 Rule、Hook 或 Agent 的安全语义；
- 自动声明 Pi `supported`；
- 绕过 manifest、lint、测试、版本和 review；
- 把个人偏好直接发布给所有用户。

正式流程由 `marketplace-dev-tools` 负责。Pi Hook/Agent/Plugin 还必须满足明确 `runtime.pi` 兼容声明、reviewed adapter 和版本级 allowlist。

## 验收标准

1. 一次性经验不会收到 Plugin 建议；
2. 单个通用 Rule 会建议独立 Rule，而不是 Plugin；
3. Plugin 建议必须说明多个组件为何必须协作；
4. 晋升前展示完整证据和隐私检查；
5. 未经用户确认不写任何外部仓库；
6. Marketplace 校验失败时只报告，不回写为“已沉淀”；
7. 已晋升知识保留来源关系，后续可追踪过期和替代版本。
