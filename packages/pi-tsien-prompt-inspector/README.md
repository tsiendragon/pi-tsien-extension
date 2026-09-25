# pi-tsien-prompt-inspector

把「模型实际收到的最终 payload」可视化：优先用 `before_provider_request` 落盘的真实载荷，没有时实时重建一份近似视图。

## 命令

- `/prompt`

## 事件钩子

`before_provider_request`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
