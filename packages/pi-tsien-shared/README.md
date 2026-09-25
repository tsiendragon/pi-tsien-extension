# pi-tsien-shared

被各 `pi-tsien-*` 扩展共用的代码：dashboard 桥接（dashboard-bridge）、live feature 观察者（live-observer）、命令 UI 组件（command-ui）、后台命令管理（background-commands），以及自动压缩触发策略（auto-compact-target/core.ts）。

不是扩展：不声明 `pi.extensions`，由其它包通过包名引用（例如 `pi-tsien-shared/src/lib/live-observer.ts`）。

## 配置

无（无自己的配置文件）

## 依赖

- 内部：无

## 说明

消费方：live-session、running-commands、schedule、side-chat、subagent-workbench、auto-compact、context-powerline。

## 使用方式

本包不是扩展，不放进 `loadOrder`。其它包在 `package.json` 里把它列为依赖，然后按包名引用：

```ts
import { publishLiveFeature } from "pi-tsien-shared/src/lib/live-observer.ts";
import { resolveCompactionTrigger } from "pi-tsien-shared/src/auto-compact-target/core.ts";
```

仓库内由 npm workspaces 链接到根 `node_modules`，因此本地无需发布即可解析。
