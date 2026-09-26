# Quickstart：别人怎么用这套扩展

> 本文件只写**已实测过**的命令。2026-09-26 按「外部用户视角」在**全新 HOME + 匿名 clone** 下走通了：
> 匿名 `git clone`（仓库公开）→ 仓库根 `npm install`（162 个包 / 26 个工作区链接）→
> `pi install <路径>` ×2（无依赖包 + 带内部依赖包）→ `pi list` → dashboard Extensions 清单识别（0 告警）。
> 未验证的地方会明确标注。

## 0. 前提

| 项 | 要求 |
|---|---|
| Node | ≥ 22 |
| pi | `@earendil-works/pi-coding-agent` |
| 补丁版 pi | 只有 3 个包需要，见下表；其余 23 个用上游原版即可 |

需要补丁版 pi 的包（用到上游不存在的 API）：

| 包 | 补丁 API |
|---|---|
| `pi-tsien-live-session` | `extension_ui` / `respondExtensionUi` / `extension_ui_notify` |
| `pi-tsien-code-mode` | `executeTool` |
| `pi-tsien-subagent-workbench` | `executeTool` |

补丁版构建产物：<https://github.com/tsiendragon/pi/releases>（`v0.85.1-tsien.1` 起，含 10 个平台 tarball）。

## 1. 装扩展（推荐：从 npm）

```bash
pi install npm:pi-tsien-web-tools        # 单个扩展
pi install npm:pi-tsien-live-session     # 依赖 pi-tsien-shared 会自动一起装
pi list                                  # 确认
```

**`npm:` 前缀不能省。** 裸名字会被 pi 当作本地路径：

```
pi install pi-tsien-shared        → Error: Path does not exist: ./pi-tsien-shared
pi install npm:pi-tsien-shared    → Installed npm:pi-tsien-shared
```

装完的落盘位置（内部依赖由 npm 自动装到同一个 `node_modules`）：

```
~/.pi/agent/npm/
├── package.json                 {"dependencies":{"pi-tsien-live-session":"^0.1.0"}}
└── node_modules/
    ├── pi-tsien-live-session/
    └── pi-tsien-shared/         ← 共享库，自动装好
```

`settings.json` 里记的是 `"npm:pi-tsien-live-session"`（这个形式 dashboard 的 Extensions 页面也能正确解析）。

## 2. 装扩展（未发布到 npm 的，或你要改代码）

先建立工作区链接（**必须在仓库根先 `npm install`**，否则跨包 import 找不到兄弟包）：

```bash
git clone https://github.com/tsiendragon/pi-tsien-extension.git
cd pi-tsien-extension && npm install
pi install /abs/path/to/pi-tsien-extension/packages/pi-tsien-memory
```

`settings.json` 会记为相对路径（如 `../../../../abs/path/.../packages/pi-tsien-memory`），这是 pi 的正常行为。
注意 `pi install git:github.com/user/repo` **只能装仓库根**（不支持子目录），所以 monorepo 里的单包要用本地路径。

## 3. 装 dashboard（图形化管理）

```bash
git clone https://github.com/tsiendragon/pi-dashboard.git
cd pi-dashboard && ./scripts/install-standalone.sh
# 按提示把 PI_SCRIPT 指向你自己的 pi，然后：
./run.sh
```

打开 **Extensions 页面**（`/extensions`）：清单 / 启停 / 排序 / 安装 / 审计 / 回滚，详见 `docs/extensions-page.md`。

两个必须知道的点：

1. **写操作需要先认证一次**（dashboard 默认监听 `0.0.0.0` 且只读开放）：在终端或 live-session 页粘贴启动日志里的令牌，
   浏览器随后自动带 cookie；纯浏览不需要认证。
2. 想更收敛暴露面就设 `PI_DASH_HOST=127.0.0.1`。

## 4. 发布状态（诚实说明）

26 个包中 **10 个已在公共 npm**：`shared`、`auto-compact`、`capability`、`code-mode`、`compact-continue`、
`context-powerline`、`default-system-prompt`、`git-graph`、`goal`、`live-session`。

其余 16 个（`memory`、`metrics-sidebar`、`observation-pack`、`prompt-inspector`、`rtk-fork`、`running-commands`、
`schedule`、`session-aliases`、`session-ui-fork`、`side-chat`、`sidebar`、`subagent-workbench`、`thinking-level`、
`trajectory-recorder`、`usage-analytics`、`web-tools`）**尚未发布**：首次批量发布撞上 npm 的突发限流（
`429 rate limited exceeded`，账号级、无 `Retry-After`），后续会放慢节奏补发。在那之前请用上面的「本地路径」方式安装。

补发命令（维护者用，token 从 vault 注入，绝不落盘）：

```bash
sekret local exec tsien account -- npm run publish:packages    # 断点续发，已发布的自动跳过
```

## 5. 常见坑速查

| 现象 | 原因 / 处理 |
|---|---|
| `Path does not exist: ./pi-tsien-xxx` | 漏了 `npm:` 前缀 |
| 扩展加载报模块找不到（跨包 import） | 从源码装时没在仓库根 `npm install`（缺 workspace 链接） |
| dashboard 安装/启停返回 401 | 写操作需要浏览器认证，按提示粘贴令牌一次 |
| dashboard 页面显示 `npm 包尚未安装` | 该包还没 `pi install npm:<name>`（页面提示里带命令） |
| `429 rate limited exceeded`（发布时） | npm 账号级突发额度；停下等，别连发 |