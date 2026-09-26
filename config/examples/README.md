# 配置示例（config/examples）

这里的文件都是**模板**：复制到 Pi 的 agent 目录并改成自己的值即可，仓库里的这份不会被打架。

| 文件 | 复制到哪里 | 用途 |
|---|---|---|
| `bash-digest.example.json` | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/bash-digest.json` | 大段 `bash` 输出交给便宜模型摘要（默认关闭） |
| `extensions.config.example.json` | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions.config.json`，或用 `install-standalone.sh --ext-config <文件>` | Pi 扩展**装载清单**（声明 package 来源、加载顺序、严格模式收敛策略） |

改完执行 `/reload` 生效。扩展按 `packages/pi-tsien-*` 各包的 TS 入口直接加载（见 `docs/packages-migration.md`），不需要编译。

## bash-digest：模型与凭证怎么配

摘要用的模型走**宿主 pi 自己的 provider 配置**（`ModelRegistry`），所以有两层：

1. **用哪个模型** —— `digestModel`，格式 `provider/modelId`（见上表文件里的字段）。
   必须是宿主 pi 已经认得并配好凭证的 provider。
2. **凭证从哪来** —— 不在本文件里，而是宿主 pi 的 provider 认证，通常是环境变量：

| provider 示例 | `digestModel` 写法 | 需要的环境变量 |
|---|---|---|
| 阿里云 DashScope（默认值） | `dashscope/qwen3.8-flash` | `DASHSCOPE_API_KEY` |
| Anthropic | `anthropic/claude-haiku-4.5`（按你的清单里实际 id 写） | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5-mini`（按实际 id 写） | `OPENAI_API_KEY` |
| 本地兼容 OpenAI 的网关 | 需先在 pi 的 provider 配置里声明该 provider | 按你声明的变量名 |

这些环境变量放哪里都可以，只要能进到 pi 进程：

- **用 pi-dashboard 时（推荐）**：写进 dashboard 的环境文件
  `${PI_CODING_AGENT_DIR:-~/.pi/agent}/dashboard.env`，dashboard 启动时自动加载，
  并且会传给它启动的**每一个** pi 子进程（`backend/env-file.ts`）。
  模板见 `pi-dashboard/.env.example`，说明见 `pi-dashboard/docs/env-configuration.md`。
- **纯命令行用 pi 时**：写进 shell profile（`~/.bashrc`/`~/.zshrc`），或 pi 的 `/login`。
- **systemd 起 dashboard 时**：不用改 unit，环境文件已经覆盖。

## extensions.config：扩展装载清单

同步器（`scripts/pi-extension-sync.mjs`）的唯一输入，三个字段：

| 字段 | 含义 |
|---|---|
| `packages[]` | 扩展来源：`{id, source}`。`source` 可以是绝对路径（本地 checkout）、git URL，或含 `${PI_TSIEN_EXTENSION_ROOT}` / `${PI_MARKETPLACE_ROOT}` / `${HOME}` 的模板 |
| `loadOrder[]` | 加载顺序 = 生效顺序。`{package, path}` 或直接 `{path: 绝对路径}` |
| `prune` | 严格模式：`packages`/`extensions` 为 true 时，不在清单里的会被移除；`autoDiscoveredExtensions: "quarantine"` 把未托管的单文件扩展移入隔离目录 |

要点：

- 写进清单 ≠ 生效：同步器默认 dry-run，要 `--apply` 才写 Pi 的 `settings.json`（原文件会备份到 `<agent dir>/extension-sync-backups/<时间戳>/`）。
- 只声明不存在的本地路径会**明确报错**，不会静默跳过。
- 引用 `${PI_MARKETPLACE_ROOT}` 时该变量必须可解析（想不接内部 marketplace 就别引用它，见 `extensions.standalone.json`）。
- 完整可用的 25 项清单在 `../extensions.standalone.json`；示例文件故意只留几项，方便看懂结构。
- 非 schema 字段（如 `_comment`）会被忽略，可用来写注释。

## 怎么确认真的生效

bash-digest **不会因为模型调用失败而报错**，它只是回落到原文（设计如此）。判断方法：

- 生效：大段、非 `excludePatterns` 的 bash 输出会被改写成
  `[digest 703 tok -> 60 tok | raw: obs_xxx]` + 一段摘要。
- 没生效（常见原因：`digestModel` 不存在、凭证缺失、超时）：同样的大段输出原样出现。

排查顺序：`digestModel` 的 provider/modelId 是否在 `pi` 的模型清单里 → 对应环境变量是否在
pi 进程里可见（dashboard 起来时看 `[env] loaded env file(s): …` 那行日志）→ 提高 `timeoutMs`。

注意 `excludePatterns` 里默认排掉了 `ls`/`find`/`git log`/`grep`/`cat` 这类「列出条目」的命令，
它们的输出**本来就不该摘要**（丢行就是丢事实），所以用这些命令永远看不到 digest 标记，属正常。