# Research Session

**research_id**: deepseek-ptc-pi-integration_20260814_173937
**topic**: 分析 DeepSeek Programmatic Tool Calling（PTC）能否加入 Pi
**goal**: 评估 PTC 接入 Pi 的可行性，形成技术接入设计，并比较 Pi 核心原生支持与 Pi 扩展实现两条路线
**output_format**: feasibility_analysis + tech_design + decision_matrix
**created_at**: 2026-08-14 17:39
**updated_at**: 2026-08-14 19:36
**current_phase**: DISCUSSING
**iteration_count**: 0
**max_iterations**: 3

## 研究维度
1. PTC 机制与接口合同
2. Pi 当前 Agent Loop 与工具调用边界
3. Pi 核心原生接入设计
4. Pi 扩展接入设计
5. 对比、风险与验证路径
6. 反方审查

## 已完成文件
- session_info.md
- research_plan.md
- ptc-mechanism.md
- pi-architecture.md
- core-integration.md
- extension-integration.md
- decision-evidence.md
- assumption-challenge.md
- synthesis_1.md

## 执行记录
- 第一轮并行工作流因总输出超过预算而失败；未直接使用聚合结果
- 五个已完成的独立只读产物被保留，并由单独的 assumption-challenger 交叉核验
- 遗留 tmux 子进程已全部关闭并确认消失

## 关键约束
- PTC 指 Programmatic Tool Calling：模型生成程序以组合、循环、条件化或并行调用工具
- 仅做研究、可行性分析与技术设计，不实现原型
- 必须比较 Pi 核心改造与 Pi 扩展两种方案
- Pi 结论需基于上游文档与源码，PTC 结论需基于 DeepSeek 一手资料或可追溯实现
- 不修改当前仓库现有代码，不触碰用户已有未提交改动

## confirmed_scope
- 可行性分析
- 技术接入设计
- 核心原生支持与扩展实现的路线比较

## output_format
- 中文 Markdown 报告
- 包含架构图或时序图（Mermaid）、改动面、风险、验证计划与推荐路线
