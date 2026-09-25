# Pi 用户级扩展管理

用户级唯一配置：

```text
~/.pi/agent/extensions.config.json
```

它同时控制：

- `packages` 数组顺序：npm、Git、本地 package 的安装/解析顺序；
- `loadOrder` 数组顺序：每个 extension 的运行时加载和初始化顺序；
- 配置外 package、直接扩展和自动发现扩展的清理。

## 配置格式

```json
{
  "version": 1,
  "packages": [
    { "id": "tsien", "source": "${PI_TSIEN_EXTENSION_ROOT}" },
    { "id": "tools", "source": "git:github.com/example/pi-tools" }
  ],
  "loadOrder": [
    { "package": "tsien", "path": "extensions/goal.ts" },
    { "package": "tools", "path": "extensions/tool.ts" },
    { "path": "${HOME}/src/direct-extension.ts" }
  ],
  "prune": {
    "packages": true,
    "extensions": true,
    "autoDiscoveredExtensions": "quarantine"
  }
}
```

规则：

- `packages` 从上到下决定 package 安装顺序，`id` 在文件内唯一。
- `loadOrder` 从上到下决定 extension 初始化顺序。
- 带 `package` 的 `path` 必须相对 package 根目录，不能包含 `..`。
- 不带 `package` 的 `path` 是直接扩展，必须解析为已存在的绝对路径。
- 从 `loadOrder` 删除一项会停用该 extension；从 `packages` 删除来源会卸载该来源。
- package 在 Pi 设置中使用 `autoload:false`：它仍会安装，但不会自行打乱 extension 顺序。选中扩展统一通过有序的 `settings.extensions` 加载。

## 同步

预览：

```bash
node /mnt/workspace/lilong/repos/pi-tsien-extension/scripts/pi-extension-sync.mjs
```

应用：

```bash
node /mnt/workspace/lilong/repos/pi-tsien-extension/scripts/pi-extension-sync.mjs --apply
```

应用后执行 `/reload` 或重启 Pi。Pi 先按 `packages` 顺序安装缺失来源，再按 `settings.extensions` 顺序逐个初始化扩展。

## 严格模式与恢复

- 配置外 package 从 `settings.json.packages` 移除。
- 配置外扩展从 `settings.json.extensions` 移除。
- `~/.pi/agent/extensions/` 中未配置的文件移到 `~/.pi/agent/extension-quarantine/<timestamp>/`。
- 原 `settings.json` 备份到 `~/.pi/agent/extension-sync-backups/<timestamp>/settings.json`。
- 其他 Pi 设置保持不变。

## 路径变量

- `${PI_TSIEN_EXTENSION_ROOT}`：优先读取环境变量，否则使用同步器所在仓库。
- `${EAGLEEYE_AI_DEV_ROOT}`：优先读取环境变量，否则发现同级 `eagleeye-ai-dev`。
  只在配置真的引用它时才会解析；未引用时机器上不需要存在该仓库。
- `${PI_AGENT_DIR}`：当前 Pi agent 配置目录。
- `${HOME}`：用户主目录。

## 独立配置（standalone）

不接入内部 marketplace 的机器使用 `config/extensions.standalone.json`：

```bash
node scripts/pi-extension-sync.mjs --config config/extensions.standalone.json --apply
```

它只声明本仓库与 `vendor/pi-web-tools` 两个 package，加载同样的 25 个 extension，
但不会要求 `eagleeye-ai-dev` 存在，也不会写入 marketplace 来源的 package。
修改共享的 `~/.pi/agent/extensions.config.json` 后，若新增的是通用 extension，
请同步补进这份 standalone 配置。
