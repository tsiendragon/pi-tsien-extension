# Research Plan — DeepSeek PTC × Pi

## 目标
评估 DeepSeek Programmatic Tool Calling（PTC）接入 Pi 的可行性，分别设计核心原生方案与扩展方案，并形成推荐路线。

## 研究维度

### 1. PTC 机制与接口合同
- Agent 类型：web-researcher
- 重点：DeepSeek 一手定义、模型输出格式、代码执行方式、工具暴露方式、状态与错误语义、性能收益及限制
- 证据优先级：DeepSeek 官方论文/仓库/文档 > 官方示例 > 可复现实作
- 产物：ptc-mechanism.md

### 2. Pi 当前 Agent Loop 与工具调用边界
- Agent 类型：domain-analyst
- 重点：模型 provider、消息流、tool-call 解析、Agent loop、扩展 API、会话持久化、工具结果回注
- 证据优先级：Pi 上游源码与官方文档
- 产物：pi-architecture.md

### 3. Pi 核心原生接入设计
- Agent 类型：domain-analyst
- 重点：协议层、代码执行器、工具代理、事件流、会话格式、兼容策略、最小改动面
- 产物：core-integration.md

### 4. Pi 扩展接入设计
- Agent 类型：domain-analyst
- 重点：现有扩展钩子能否拦截/转换模型请求与响应，能否注册 PTC runtime，哪些能力必须侵入核心
- 产物：extension-integration.md

### 5. 对比、风险与验证路径
- Agent 类型：domain-analyst
- 重点：能力完整度、维护成本、上游兼容、安全隔离、可观测性、性能、渐进式落地与测试矩阵
- 产物：decision-evidence.md

### 6. 反方审查
- Agent 类型：assumption-challenger（其他维度完成后单独执行）
- 重点：挑战 PTC 定义是否被误读、扩展路线是否伪可行、核心改造是否过度、沙箱边界是否足够、收益是否有证据
- 产物：assumption-challenge.md

## 综合输出
- feasibility_analysis.md
- tech_design.md
- decision_matrix.md
- Mermaid 架构图与时序图
- 每条关键结论附 URL 或 `文件:行号`，并标注 high / medium / low 置信度

## 明确排除
- 不编写或提交原型代码
- 不修改 Pi 上游或当前扩展源码
- 不执行正式性能 benchmark
- 不把非 DeepSeek 官方营销描述当作事实依据
