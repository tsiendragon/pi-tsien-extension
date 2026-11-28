# pi-tsien-default-system-prompt

用 `~/.pi/agent/DefaultSystemPrompt.md` 覆盖系统提示的开头并调整 Guidelines/Rules 段落；文件不存在时静默跳过。

## 兼容的系统提示格式

Pi 的系统提示段格式随版本变了，本扩展两代都认：

| 版本 | tools 段标记 | 规则段标记 |
| --- | --- | --- |
| Pi ≥ 1.6 | `<tools>` | `<rules>` |
| Pi < 1.6 | `Available tools:` | `Guidelines:` |

同一次查找里新版优先、旧版兜底，所以升级 Pi 不会因为找不到段而静默失效。

### 两个容易踩的点

- **Pi ≥ 1.6 会自己读 `DefaultSystemPrompt.md`**，所以扩展替换开头那一步在新版下是重复动作。此时不报警，只做规则段调整。
- **只认标记、不认版本号**：`pi-tsien-session-ui-fork` 也复用这里的两个纯函数，段格式再变时只需要更新 `TOOLS_SECTION_MARKERS` / `GUIDELINES_SECTION_MARKERS` 两份候选列表。改成标记失效时**不要**静默跳过——会像 1.6 升级那次一样，规则调整整整失放而无人发现。

## 事件钩子

`before_agent_start`

## 配置

`~/.pi/agent/DefaultSystemPrompt.md`（可选）

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

被 `pi-tsien-session-ui-fork` 复用（同一套段落调整函数）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
