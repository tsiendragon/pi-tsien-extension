# Extension management

Pi extension 的唯一权威配置是：

```text
~/.pi/agent/extensions.config.json
```

不要在仓库中重新创建 `config/pi-extensions.json`，也不要直接修改
`~/.pi/agent/settings.json` 的 `packages` 或 `extensions` 字段，
更不要把托管扩展复制到 `~/.pi/agent/extensions/`。这些做法会绕过
严格管理，或导致同一扩展重复加载。

使用同步器管理配置：

```bash
# 先预览差异
node <repo>/scripts/pi-extension-sync.mjs

# 确认后应用
node <repo>/scripts/pi-extension-sync.mjs --apply
```

配置规则：

- `packages` 数组顺序控制 package 的安装/解析顺序。
- `loadOrder` 数组顺序控制 extension 的运行时加载和 factory 初始化顺序。
- package 必须用 `autoload: false` 由同步器写入 Pi 设置；仅通过有序的
  `settings.extensions` 加载选中的 extension。
- 删除配置项即可停用；同步器会从 Pi 设置移除未列出的 package/extension，
  并隔离未托管的 `~/.pi/agent/extensions/` 文件。

每次应用后必须执行 Pi 的 `/reload`（或重启 Pi），使当前实例卸载旧扩展并按
新顺序加载。修改后至少重新运行一次 dry-run，确认输出为：

```text
Pi extensions already match the ordered user config.
```
