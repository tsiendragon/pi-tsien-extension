# Pi 用户级扩展管理

用户级唯一配置是：

```text
~/.pi/agent/extensions.config.json
```

它控制用户安装和加载哪些扩展，包括：

- `pi-tsien-extension` 中的单个扩展；
- npm、Git、本地目录等其他 Pi packages 中的单个扩展；
- `settings.json.extensions` 直接引用的本地扩展文件。

同步器把该配置转换为 Pi 原生的 `settings.json.packages` package filtering 和 `settings.json.extensions`，不引入另一套运行时加载机制。

## 配置格式

```json
{
  "version": 1,
  "packages": [
    {
      "source": "${PI_TSIEN_EXTENSION_ROOT}",
      "extensions": [
        "+extensions/goal.ts",
        "+extensions/memory.ts"
      ]
    },
    {
      "source": "git:github.com/example/pi-tools",
      "extensions": ["+extensions/tool.ts"]
    }
  ],
  "extensions": [
    "${HOME}/src/custom-extension.ts"
  ],
  "prune": {
    "packages": true,
    "extensions": true,
    "autoDiscoveredExtensions": "quarantine"
  }
}
```

- 从 `packages` 删除整个 source：卸载该来源，不再加载其中任何扩展。
- 从 `packages[].extensions` 删除一项：保留 package，但不加载该扩展。
- `+relative/path` 是相对 package 根目录的精确白名单。
- `extensions` 用于直接加载已存在的绝对路径；Git/npm 来源应优先写成 package，Pi 才能自动安装。

## 同步

默认只预览：

```bash
node /mnt/workspace/lilong/repos/pi-tsien-extension/scripts/pi-extension-sync.mjs
```

确认后应用：

```bash
node /mnt/workspace/lilong/repos/pi-tsien-extension/scripts/pi-extension-sync.mjs --apply
```

应用后 `/reload` 或重启 Pi。Pi 会自动安装配置中缺失的 npm/git packages。本地 package 必须已存在。

## 严格模式与恢复

- 配置外 package 会从 `settings.json.packages` 移除。
- 配置外直接路径会从 `settings.json.extensions` 移除。
- `~/.pi/agent/extensions/` 中未被配置引用的自动发现文件会移到 `~/.pi/agent/extension-quarantine/<timestamp>/`，不会永久删除。
- 原 `settings.json` 备份到 `~/.pi/agent/extension-sync-backups/<timestamp>/settings.json`。
- `settings.json` 其他字段保持不变。

## 路径变量

- `${PI_TSIEN_EXTENSION_ROOT}`：优先读取环境变量，否则使用同步器所在仓库。
- `${EAGLEEYE_AI_DEV_ROOT}`：优先读取环境变量，否则发现 `pi-tsien-extension` 同级仓库。
- `${PI_AGENT_DIR}`：当前 Pi agent 配置目录。
- `${HOME}`：用户主目录。
