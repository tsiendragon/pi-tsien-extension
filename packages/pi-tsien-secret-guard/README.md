# pi-tsien-secret-guard

提交和推送前的敏感信息闸门。两层拦截，一套规则：

- **Pi 层**：Agent 或你在 Pi 里执行 `git commit` / `git push` 时先扫一遍，拦住并把具体位置和修法告诉 Agent。
- **Git 钩子层**：装到 `core.hooksPath`，终端里手敲的 git、IDE 的 git、别的 agent 全部走同一条检查。

## 查什么

| 类别 | 举例 | 谁能放行 |
| --- | --- | --- |
| 私钥 | `-----BEGIN OPENSSH PRIVATE KEY-----` | 只能人工白名单 |
| 云平台密钥 | AWS / 阿里云 / 腾讯云 / GCP / Azure | 只能人工白名单 |
| 服务令牌 | GitHub、GitLab、OpenAI、Slack、Stripe、npm、HuggingFace | 只能人工白名单 |
| 登录令牌 | JWT | 只能人工白名单 |
| 带账号密码的网址 | `https://user:pass@host` | 只能人工白名单 |
| 内网地址 | `10.x` / `192.168.x` / `172.16-31.x` / `*.corp` / `*.svc.cluster.local` | 只能人工白名单 |
| 身份证号 | 校验位正确的一律硬拦 | 只能人工白名单 |
| 手机号 / 邮箱 / 人名 | 结构化字段里的真人信息 | 只能人工白名单 |
| 本机个人路径 | `/home/<名字>/`、`C:\Users\<名字>\` | AI 可判为示例、白名单 |
| 明文口令赋值 | `password = "..."`、`api_key: ...` | AI 可判为示例、白名单 |
| 高熵随机串 | 40 位以上、混合字符类的裸串 | AI 可判为示例、白名单 |

设计原则：**内网地址和个人信息只认人工白名单**。因为模型会把真实手机号和真实姓名判成“示例”放过，那个代价太大，所以 AI 只允许处理“这串到底是不是密钥”这种模糊判断。

## 怎么拦

1. 提交前看暂存区的新增行（`git diff --cached`）。
2. 推送前看还没推出去的提交（`git log -p <local> --not --remotes`）。
3. 只看新增行，跳过锁文件、构建产物、二进制和大文件。

## 安装

```bash
# 装 git 钩子（用户级，对所有仓库生效）
node packages/pi-tsien-secret-guard/src/cli.ts install-hooks

# 只装当前仓库
node packages/pi-tsien-secret-guard/src/cli.ts install-hooks --repo
```

装了钩子之后，仓库自己的 `.git/hooks/pre-commit` 会被链式调用，不会丢；
但仓库若设置了 `core.hooksPath`（例如 husky），仓库级配置会覆盖用户级钩子。

## 用法

```bash
secret-guard scan --staged          # 手动扫暂存区
secret-guard scan --push            # 手动扫待推送提交
secret-guard scan --staged --no-ai  # 只用规则，不调模型
secret-guard scan --staged --verbose # 连“放行了哪些、为什么”一起打印
```

Pi 里也可以用 `/secret-guard`（默认扫暂存区）和 `/secret-guard push`。

## 放行

按优先级：

1. **改掉**：换成占位符，或从环境变量读取。
2. **行内标记**：在该行或上一行加 `secret-guard:allow`。
3. **整类放行**：仓库根写 `.secret-guard-allow`，一行一条，**必须写原因**：

```
packages/foo/test/*.ts *  # 测试夹具里全是故意编造的假密钥
docs/*.md local_path      # 文档里的绝对路径是给人看的示例
```

4. **临时整体关闭**：`SECRET_GUARD_DISABLE=1 git commit ...`，或 `git commit --no-verify`（只对 git 钩子生效，Pi 层仍然会扫）。

## 规则放哪儿（重要）

扫描器自身的规则表就是一份「什么算敏感」的清单，不该跟着代码一起提交。
按敏感程度分三层，越往下越私有：

| 放哪儿 | 会不会被提交 | 能放什么 | 绝对不能放 |
| --- | --- | --- | --- |
| 代码里的内置规则 | 会 | 通用密钥格式（AWS、GitHub、私钥……） | — |
| `<仓库>/.secret-guard.json` | **会** | 跳过哪些目录、用哪个模型、AI 失败怎么办 | 关键词、内网域名、自家票据格式 |
| `<仓库>/.secret-guard.local.json` | **不会** | 拦截关键词、自家 ID 格式、内网域名 | — |
| `~/.config/secret-guard/config.json` | **不会**，且不在任何仓库里 | 公司级关键词、跨项目通用规则（**组织专有词放这里**） | — |

**为什么 `.secret-guard.json` 里不能放关键词和正则？** 因为它会跟着提交走，而这些内容本身就是情报：
`blockedKeywords` 等于告诉人「该绕开什么」，`extraPatterns` 里的内网域名等于一份资产清单，
`skipPaths` 会暗示「哪个目录里有不想被扫的东西」。扫描器也抓不到——文件里写的是正则文本，不是真实域名。

所以这条边界做成了机械检查，不靠自觉：

- 在会被提交的配置里出现 `blockedKeywords` 或 `extraPatterns` → **直接阻断提交**，报「私有规则放进了会提交的文件」。
  **没有例外开关**：想共享规则只能走私有层，或者大家各自填全局配置。
- 私有配置文件被人 `git add -f` 强塞进提交 → 单独阻断，报「私有规则文件被强行加进了提交」。

`install-hooks` 会自动把 `.secret-guard.local.json` 写进 `.git/info/exclude`（不是 `.gitignore`，
所以连「这个仓库有私有规则」这件事都不会出现在 diff 里），并生成空模板。

关键词和自定义正则在各层之间**取并集**：加一层只会多拦，不会把上层抹掉。

**`.secret-guard-allow` 也要当心**：它同样会被提交。写原因时别把架构写进去，
例如别写「`config/prod/*` 密钥由 vault 注入」，改成「生产配置的示例值」。

```json
{
  "blockedKeywords": ["内部项目代号", "某个不能外传的词"],
  "extraPatterns": [
    {
      "id": "acme-session-cookie",
      "pattern": "ACMESESS-[0-9a-f]{16}",
      "category": "provider_token",
      "note": "自家会话票据格式"
    }
  ]
}
```

- `blockedKeywords`：不区分大小写的子串匹配，命中即阻断，**只有人工白名单能放行**。
- `extraPatterns`：正则源码写在 JSON 里，`id` 必填（同名后者覆盖前者），
  `flags` 默认 `"i"`，需要区分大小写时传 `""`；正则写错只跳过这一条，不影响其他规则。

内置规则只覆盖**通用格式**（AWS、GitHub、私钥、手机号……），
人名词、项目代号、工单前缀、内网域名这些**组织专有内容一律走关键词**，放私有层。
示例：人名的各种拼法用正则兜，字面名字用关键词兜。

```json
{
  "blockedKeywords": ["某项目代号", "某人姓名", "/mnt/某个私有目录"],
  "extraPatterns": [
    { "id": "person-name-variants", "pattern": "li\\w*[\\s._-]*ming", "category": "person_name" },
    { "id": "ticket-prefix", "pattern": "\\bOPS\\b", "flags": "", "note": "区分大小写，不误伤英文 ops" }
  ]
}

## 配置

仓库根 `.secret-guard.json`，或 `~/.config/secret-guard/config.json`（仓库覆盖全局）：

```json
{
  "enabled": true,
  "aiReview": true,
  "aiModel": "google/gemini-2.5-flash",
  "aiTimeoutMs": 12000,
  "maxLines": 6000,
  "onAiFailure": "notice",
  "aiRescueCategories": ["high_entropy", "credential_assignment", "local_path"],
  "skipPaths": ["**/*.lock", "**/dist/**"],
  "downgrade": {}
}
```

- `onAiFailure: "notice"`：模型不可用时，可救回的线索降级为提示放行，硬凭证照样阻断。改成 `"block"` 则一律阻断。
- `downgrade`：把某个类别降级成只提示，不阻断。例：`{"local_path": "notice"}`。
- `aiReview: false`：完全不调模型，只看规则。
- `loadConfig(cwd, { withGlobal: false })`：只看仓库自己的规则，不叠加全局配置。

## AI 复核怎么起作用

只有出现**可救回的类别**（上面表格最后一列）时才调模型，没命中就不花 token。

Pi 层用当前会话模型，进程内调用，不额外起进程；git 钩子不在 Pi 里，另起一次非交互 `pi -p`，大约多花 2-4 秒。所以：

- 干净提交：约 0.3 秒（纯规则）
- 命中可救回内容：约 3-4 秒（多一次模型调用）

## 代价与边界

- AI 只做“是不是示例”的判断，判断不了就按 `unclear` 处理，仍然阻断。
- 已知漏点：不扫 `curl` / `gh` 之类把内容直接发出去的外泄路径。
- 已知漏点：仓库设了 `core.hooksPath`（husky 等）时，用户级钩子不生效。
- `--no-verify` 能绕过 git 钩子，但绕过不了 Pi 层；两层一起装才有意义。
- 真凭证即使只提交到本地没推，也算已经泄漏过：删代码不够，必须去后台作废重发。