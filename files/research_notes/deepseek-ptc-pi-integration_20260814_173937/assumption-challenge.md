# Assumption Challenge

## 审查结论

1. **“PTC 是 DeepSeek 专有模型协议”不成立。** PTC 是官方中文界面的 Agent preset 名，英文名为 Code mode；模型仍发出普通 `run_code` 函数调用，SDK、代码运行与嵌套工具调度由 Harness 完成。置信度：high。
2. **“只改 provider 就能获得完整 PTC”不成立。** provider 能转换模型流，但完整能力依赖可重入工具调度、父子调用关联、取消、审计和隔离运行时。置信度：high。
3. **“Pi 扩展可透明调用任意活动工具”不成立。** 当前 ExtensionAPI 暴露 `getAllTools()` 元数据、`registerTool()` 和工具前后事件，但没有统一的 `invokeTool/executeTool`。置信度：high。
4. **“worker thread 是安全沙箱”不成立。** DeepSeek 官方明确称其为 containment 而非 security boundary；Pi 也明确没有内建沙箱。置信度：high。
5. **“PTC 必然省 token、降低时延”证据不足。** 官方只说明它以单个 transport schema + SDK 替换工具 schema，并把中间结果留在执行环境；是否获益取决于任务、SDK 长度、运行时启动和模型行为。置信度：high。

## 致命问题

- 把 Harness 功能误写成模型/provider wire protocol。
- extension-only full PTC 缺少统一动态工具 broker。
- 在 Pi 宿主进程、Node `vm` 或普通 worker 中执行任意模型代码，却宣称安全隔离。
- 对有副作用工具做崩溃重放或自动重试；DeepSeek Code Mode 本身也不回滚副作用。
- 没有真实对照实验就承诺质量、token 或时延收益。

## 可管理问题

- 首期仅开放只读工具 allowlist。
- 设置调用数、并发、计算时间、墙钟时间、内存和输出上限。
- 保存 outer call 与 sub-call 的关联和脱敏审计记录。
- 取消时终止运行时并等待子调用收敛。
- provider/runtime 不可用时显式回退普通工具调用。
- DeepSeek thinking tool calls 必须持续回传 `reasoning_content`。

## 最强证据

- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/code/preset.yml
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/code/agent.cordis.yml
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/locales.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/code-runtime/code-runtime-worker-thread/README.md
- https://api-docs.deepseek.com/guides/tool_calls/
- https://api-docs.deepseek.com/guides/thinking_mode/
- `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:78-145,287-540`
- `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:866-1026`
- `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:751-845,1646-1668,1705-1831`
- `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/security.md:31-50`
