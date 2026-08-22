# pi-tsien-memory

面向 Pi coding agent 的用户记忆扩展。

目标很简单：用户只管正常工作，Agent 自动记住稳定偏好、已确认决策和可复用经验，并在以后真正需要时自动想起来。

## 产品文档

- [总 PRD](docs/PRD.md)
- [Tech Design](docs/TECH_DESIGN.md)
- [任务 1：日常知识自动沉淀](docs/prd/01-daily-capture.md)
- [任务 2：自动召回并注入上下文](docs/prd/02-auto-recall.md)
- [任务 3：查看、纠正与遗忘](docs/prd/03-user-control.md)
- [任务 4：与 pi-knowledge 协作](docs/prd/04-pi-knowledge-collaboration.md)
- [任务 5：知识晋升到 EagleEye Marketplace](docs/prd/05-marketplace-promotion.md)
- [任务 6：交付阶段与可替换模块](docs/prd/06-delivery-plan.md)
- [实施状态与验收记录](docs/IMPLEMENTATION_STATUS.md)

## 当前实现

已按 Tech Design 实现 Stage 0～7：本地 SQLite/FTS5、显式与自动 Memory、scope 隔离、召回注入、冲突生命周期、可选 `pi-knowledge` versioned bridge，以及只生成本地证据包的 promotion advisor。

运行要求：Node.js `>=22.13.0`，SQLite 必须启用 FTS5。构建并验证：

```bash
npm install
npm run check
```

Pi 工具包括 `memory_search`、`memory_remember`、`memory_update`、`memory_forget`、`memory_review`、`memory_undo`、`memory_doctor`、`memory_promote_preview` 等；命令入口为 `/memory recent|recalled|review|doctor|forget|undo|on|off`。

回合结束捕获到 candidate 后，有 UI 的 Pi 默认会逐条弹出 `Accept / Reject / Later` 审核；无 UI、超时或配置 `capture.reviewCandidates=false` 时保持 candidate，不自动激活。可在配置中设置 `capture.reviewPromptTimeoutMs`（默认 15000 毫秒）。

promotion 只写入本地 `~/.pi/tsien-memory/proposals/` 证据包，不自动提交或发布到外部仓库。
