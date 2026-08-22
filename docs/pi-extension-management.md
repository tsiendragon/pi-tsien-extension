# Pi 扩展声明式管理

`config/pi-extensions.json` 是当前 Pi 扩展安装状态的唯一清单。它同时管理：

- `~/.pi/agent/settings.json` 中的 Pi packages；
- `~/.pi/agent/extensions/` 下的独立扩展文件。

## 使用

先预览，不写入：

```bash
node scripts/pi-extension-sync.mjs
```

确认后应用：

```bash
node scripts/pi-extension-sync.mjs --apply
```

应用后重启 Pi；Pi 会根据 `settings.json.packages` 自动安装缺失的 npm/git packages。本地 package 直接从清单解析后的目录加载。

## 严格同步行为

- 清单缺失的 package 会从 `settings.json.packages` 移除，因此不再加载；Pi 自己的下载缓存可能保留，但不属于已安装状态。
- 清单缺失的独立扩展不会永久删除，而会移动到 `~/.pi/agent/extension-quarantine/<timestamp>/`。
- 修改前的 `settings.json` 和被覆盖的独立扩展会备份到 `~/.pi/agent/extension-sync-backups/<timestamp>/`。
- 默认是 dry-run；只有 `--apply` 才写入。
- 不修改 `settings.json` 的其他字段。

## 路径变量

清单支持：

- `${REPO_ROOT}`：本仓库根目录；
- `${EAGLEEYE_AI_DEV_ROOT}`：优先读取同名环境变量，否则自动发现本仓库同级的 `eagleeye-ai-dev`；
- `${HOME}`：当前用户主目录。

可覆盖默认位置：

```bash
node scripts/pi-extension-sync.mjs \
  --config /absolute/path/pi-extensions.json \
  --agent-dir /absolute/path/.pi/agent \
  --apply
```

## 添加扩展

标准 Pi package 应加入 `packages`。不要复制 Marketplace 安装产物；直接引用 `eagleeye-ai-dev` 中带 `package.json` 的 Pi package 目录。

确实只能以单文件存在的扩展可加入：

```json
{
  "target": "example.ts",
  "source": "${REPO_ROOT}/managed-extensions/example.ts"
}
```

其中 `target` 只能是文件名，`source` 必须存在。配置外单文件将在下一次 `--apply` 时被隔离。
