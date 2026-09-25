# pi-tsien-web-tools

`WebSearch`（网页搜索）与 `WebFetch`（网页正文提取）两个工具，供 pi 使用。

**这是我们自己的实现**，不是 `vendor/pi-web-tools` 的副本（后者是第三方代码、上游无许可证）。
行为契约与我们在用的那份一致，但代码、结构、解析方式都是重写的：便于自由维护、扩功能，也避免许可证问题。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `WebSearch` | `query`、`limit`（默认 10，上限 20） | 返回编号列表：标题 / URL / 摘要 |
| `WebFetch` | `url`、`prompt`（可选提示，仅作上下文） | 抓取网页 → 提取正文 → markdown；结果按 pi 的 `truncateHead` 限额截断 |

## 搜索后端

无需任何凭证即可用：默认走 DuckDuckGo lite HTML（抓取页面）。有 key 时可用更好的后端。

| 后端 | 需要的环境变量 | 说明 |
|---|---|---|
| `duckduckgo` | — | 默认兜底；抓 `lite.duckduckgo.com/lite/`，不保证稳定 |
| `brave` | `BRAVE_API_KEY` | Brave Search API |
| `kagi` | `KAGI_API_KEY` | Kagi Search API（`Bot` 认证，只取 `t:0` 的网页结果） |
| `google` | `GOOGLE_API_KEY` + `GOOGLE_CX` | Google Programmable Search |
| `searxng` | `SEARXNG_URL` | 自建实例，`/search?format=json` |

选择顺序：`PI_WEB_SEARCH_PROVIDER` 显式指定 → 否则按 brave → kagi → google → searxng 自动探测（第一个凭证齐全的）→ 都没有则 duckduckgo。

> 四个 JSON 后端目前**没有真实 key 可测**（本机未配置），只有用假 fetch 做的请求构造与响应映射单测；
> 端到端行为未验证。DuckDuckGo 路径已对真实页面验证。

## 与第三方 `pi-web-tools` 的差异（有意为之）

1. **解析方式**：不依赖「属性顺序 + 双引号」的正则，改为标签扫描；单引号/双引号、`href` 在前或在后都能解析，
   并解开 `//duckduckgo.com/l/?uddg=…` 重定向（原实现解析不到时 WebSearch 全空返回）。
2. **摘要配对**：链接与摘要分别按文档顺序取出后按位置配对，避免两个表格错位。
3. **实体解码**：支持命名实体与数字实体（`&#39;` / `&#x27;`）；标签只把**块级标签**当空格，
   所以 `sub-agents`、`pi-coding-agent` 这类词不会被拆开。
4. **markdown 清理**：只在空格/制表符上收拾标点前的空白，**不吞换行** —— 原实现会把 `\n.` / `\n,` 折平成
   `{. = 200;.` 这种把代码块多行挤成一行的结果。
5. **懒加载**：jsdom / Readability / turndown 在首次 `WebFetch` 时才 import（原实现同样做了这一步，
   启动耗时从 ~1.7s 降到 0.6~0.8s，这里保留）。
6. 额外护栏：HTML 5MB 上限、content-type 白名单、`limit` 上限 20。

## 验证

```
node --import tsx --test --test-timeout=60000 test/*.test.ts   # 26 tests
```

- 单测覆盖：标签扫描（含嵌套/未闭合/引号内 `>`）、实体解码、DDG 新旧两种 markup、limit、
  四个 JSON 后端的请求构造与结果映射、正文提取与三种错误路径。
- A/B 对比（与 `vendor/pi-web-tools` 同一批真实页面）：
  - 搜索：3 个真实查询 × 10 条结果，**URL、标题、摘要归一化后逐条一致**；
  - `https://example.com/`：提取结果完全一致；
  - `https://nodejs.org/en/about`：**去掉全部空白后逐字符相同**（4339 字符），差异只在换行保留方式（见差异 4）。

## 状态与发布

- 目前通过 monorepo 内的本地路径加载（`packages/pi-tsien-web-tools`），`package.json` 的
  `pi.extensions` 指向 `./src/index.ts`。
- **尚未发布**：npm 发布前需要先定许可证（当前仓库与包都没有 LICENSE 字段）。
- `peerDependencies` 指向 `@earendil-works/pi-coding-agent` / `typebox`；`jsdom` 与
  `turndown-plugin-gfm` 的类型来自 `src/types/runtime-shims.d.ts`（安装 `@types/jsdom` 后可删）。