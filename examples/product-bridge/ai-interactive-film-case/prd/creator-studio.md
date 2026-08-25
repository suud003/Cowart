# 创作者工作室 PRD

> Module ID: `creator-studio` · Status: draft · Case: 分岔回声
> 用户只确认“AI 互动影游 case”；创作者画像、编辑方式、指标和流程均为 AI 假设。

## 目标与指标

让互动编剧不写提示词、不穷举分支树，也能在 30 分钟内搭出可预览的最小故事：锁定世界和角色底线，定义节拍与结局，在隔离会话验证生成，并通过可定位的检查发布不可变版本。

- 无培训 30 分钟完成最小可预览故事，5 人任务成功率 ≥ 80%。
- 校验错误首次定位成功率 ≥ 90%；硬约束冲突可回溯具体规则 = 100%。
- 已发布版本无意修改或进行中会话版本漂移 = 0。

范围包括项目向导、世界、角色、红线/分级、状态变量、节拍/结局、资产标签、校验、隔离预览、发布与下架入口。不包括视频剪辑器、运行时视频生成、多人实时协作、UGC 市场、模型微调和审核后台。

## 信息架构

```text
项目：概览
├─ 世界：事实 / 地点 / 时间线 / 硬规则
├─ 角色：目标 / 秘密 / 语气 / 关系轴 / hardNo
├─ 安全：作品红线 / 自由行动策略 / 分级
├─ 状态：关系 / 线索 / 目标 / flags
├─ 故事图：开场 / 节拍 / 汇流 / 兜底 / 结局
├─ 资产：预生成镜头 / 关键帧 / 音频 / 标签
├─ 预览：测试会话 / 状态差量 / 规则诊断
└─ 发布：校验 / 版本摘要 / 审批 / 下架
```

## 功能需求

### F-studio-01 定义世界与角色硬约束

- **前置 / 触发**：创作者有草稿编辑权，进入世界或角色模块。
- **需求**：系统应提供结构化字段定义世界事实、时间/地点、角色目标、秘密、语气、关系轴和不可违背项，并区分硬约束与风格偏好。
- **规则**：每条规则有稳定 ID、说明、级别、对象和示例；验证重复/循环引用；hardNo 必须可判断；自动保存使用 revision 且不覆盖并发修改。
- **状态**：empty-guide, editing, dirty, saving, saved, field-error, conflict。
- **来源**：AI 假设 `A-studio-world`。
- **验收**：
  - Given 新项目，Then 显示世界一句话、至少一条硬规则、至少一名角色的 checklist。
  - Given 同一事实出现互斥值，When 保存，Then 定位两条规则且不静默选择。
  - Given hardNo 不可判断，When 校验，Then 提示改写为可观察行为并给例子。
  - Given 两窗口同 revision 编辑，Then 后保存者进入 conflict，先保存内容不被覆盖。
- **Prototype**：`studio.world-rules`。

### F-studio-02 配置内容红线与自由行动策略

- **前置 / 触发**：平台安全策略已加载；创作者进入安全设置。
- **需求**：系统应支持分级、敏感提示、作品禁止内容，以及自由行动的澄清/安全映射/拒绝策略，并说明平台规则不可被作品放宽。
- **规则**：平台规则只读且最高优先；作品只能收紧；每条红线有玩家替代策略或拒绝文案；分级变化触发全量重检。
- **状态**：policy-loading, configured, warning, blocked, revalidation-required。
- **来源**：AI 假设 `A-studio-safety`。
- **验收**：
  - Given 平台禁止项，When 尝试允许，Then 控件不可放宽并解释优先级。
  - Given 作品红线无替代策略，When 发布，Then 阻断并定位。
  - Given 分级 18+ 改为 13+，Then 旧校验失效并重扫样例与资产元数据。
  - Given 预览命中边界，Then 诊断显示规则 ID 与结果，不显示隐藏推理。
- **Prototype**：`studio` 规则与诊断区。

### F-studio-03 编排节拍、汇流与结局

- **前置 / 触发**：世界、角色和类型化状态已存在；创作者编辑故事图。
- **需求**：系统应支持节拍目的、前置条件、允许出口、状态范围、资产标签和预写兜底，并用图与等价列表展示；结局以确定性条件和显式优先级定义。
- **规则**：每个可行动节拍至少一个出口和 fallback；条件只引用已定义状态；起始节拍唯一，主结局可达；多结局同时满足时优先级必须唯一。
- **状态**：canvas/list, node-selected, invalid-edge, unreachable, dead-end, ending-conflict。
- **来源**：AI 假设 `A-studio-beats`。
- **验收**：
  - Given B2 无出口且非结局，Then 标记阻断死路并同步到列表。
  - Given 条件引用待删除状态，Then 阻止删除或要求替换引用。
  - Given E1/E2 同时满足且同优先级，Then 阻止发布。
  - Given 关系密集，When 切换列表，Then 键盘可查看相同节点、条件和出口。
- **Prototype**：`studio.beat-graph`。

### F-studio-04 创建隔离预览并诊断 AI 回合

- **前置 / 触发**：草稿满足最低编译条件；创作者选择预览或从节拍测试。
- **需求**：系统应冻结临时测试快照，创建不影响玩家数据的隔离会话，并显示玩家视图、归一化意图、命中规则、状态差量、资产选择、延迟和成本摘要。
- **规则**：预览标记 TEST，不计玩家指标；可从指定节拍和合法状态开始；诊断只展示解释代码；草稿改变后旧预览提示已旧。
- **状态**：preparing, playable, generation, violation, fallback, stale-preview, ended。
- **来源**：AI 假设 `A-studio-preview`。
- **验收**：
  - Given 草稿可编译，When 预览，Then 创建独立 testSnapshotId/session，正式版本不变。
  - Given 回合改变关系，Then 显示 before、delta、after 与规则 ID。
  - Given 计划违反 hardNo，Then 诊断定位角色/规则并显示 fallback。
  - Given 预览时草稿修改，Then 提示快照已旧，不热更新。
- **Prototype**：`studio` 预览/诊断区。

### F-studio-05 校验并发布不可变版本

- **前置 / 触发**：创作者有发布权；草稿已保存并完成当前 revision 全量校验；点击发布。
- **需求**：系统应确认 revision，阻止所有 blocker，要求确认 warning，生成有 checksum 的不可变 `StoryVersion`，记录发布者、时间和审批状态；后续编辑产生新草稿。
- **规则**：blocker 不可绕过；warning 确认留痕；发布包含约束、节拍、结局、状态 schema、资产目录和兜底；下架但不可篡改；发布事务避免半成品。
- **状态**：validating, blocked, warning-confirm, publishing, pending-review, published, publish-error, withdrawn。
- **来源**：AI 假设 `A-studio-publish`。
- **验收**：
  - Given 有 blocker，When 发布，Then 不生成版本并定位首项。
  - Given 只有 warning，Then 保存确认人、时间和规则 ID。
  - Given 资产打包失败，Then 事务回滚且无可用 StoryVersion。
  - Given V1 已发布后继续编辑，Then 发布为 V2，V1 checksum 与进行中会话不变。
- **Prototype**：`studio.validate`, `studio.publish`。

## 非功能需求

### NFR-studio-01 可学习性与效率

首次用户 30 分钟内完成“世界 + 角色 + 3 节拍 + 1 结局 + 预览”；术语有就地示例，模板明确标为示例。5 人任务成功率 ≥80%，关键步骤首次定位率 ≥80%。

### NFR-studio-02 校验可操作性与无障碍

每个问题含严重级、对象、原因、建议和定位；blocker 不可绕过。键盘可完成主流程，节拍图有等价列表，颜色非唯一编码。规则测试集 100% blocker 定位对象。

### NFR-studio-03 版本完整性与可移植性

发布版本不可变、有 checksum、可导出、可下架；保存用 revision，不静默覆盖；发布事务保证约束、节拍、资产目录和元数据完整。并发、打包失败、审批失败、下架、导入导出中不得产生 checksum 漂移或半版本。

## 风险、开放问题与非目标

- 风险：术语工程化（用创作语言渐进展开）；节拍图失控（节点上限、汇流、列表）；预览被误认为确定结果（展示变体）；校验疲劳（分级聚合但不隐藏对象）。
- `[Open]` Studio 是单页还是多页面？
- `[Open]` 是否需要多人协作、评论和审批？
- `[Open]` 可展示多详细的模型/成本诊断？
- `[Open]` 下架版本的存量会话允许完成、终止还是迁移？
- 非目标：视频剪辑、运行时视频生成、多人实时协作、UGC 市场、模型微调、审核后台。
