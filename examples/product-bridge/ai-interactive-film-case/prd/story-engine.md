# AI 叙事引擎 PRD

> Module ID: `story-engine` · Status: draft · Case: 分岔回声
> `src-user-case-brief` 仅说明要做“AI 互动影游”case；本文机制、指标和阈值均为 AI 假设。

## 目标与指标

将创作者发布的世界、角色、红线、节拍和结局编译为可执行约束；每次玩家行动后，生成可校验、可恢复、可追溯的下一场景，并原子更新会话状态。

- 硬性世界观/人设冲突回合率 < 1%；非法状态差量提交数 = 0。
- 首个有效反馈 P95 ≤ 6 秒，完整场景载荷 P95 ≤ 12 秒。
- 兜底回合率 < 5%，兜底后会话可继续率 ≥ 95%。
- 100% 已提交回合可追溯到版本、输入、计划、检查和状态前后值。

## 范围与规则

包含约束编译、行动归一化、故事计划、对白/旁白、资产标签、状态校验与提交、结局判定、降级、审计和成本计量。不包含运行时视频逐帧生成、玩家/创作者 UI、多人状态、跨作品长期记忆。

规则优先级：`平台安全 > 作品红线 > 世界/角色硬约束 > 当前会话事实 > 节拍目标 > 风格偏好 > 模型创意`。同层冲突应在发布前阻断，不能交给模型自行取舍。

## 功能需求

### F-story-01 编译并版本化故事约束

- **Actor / 前置**：创作者有编辑权；草稿含世界、角色、起始节拍、可达结局和兜底。
- **触发 / 需求**：当草稿保存、校验或发布时，系统应把世界事实、角色 hardNo、红线、类型化状态、节拍迁移、结局条件和资产标签编译成确定性 `ConstraintPackage`，返回 Blocker/Warning/Info。
- **规则**：每个硬约束有稳定 ID、来源和机器可检表达式；每个可行动节拍有出口与 fallback；相同输入产生相同 checksum；草稿变化使旧校验失效。
- **状态**：compiling, blocked, warnings, passed, stale-result。
- **来源**：AI 假设 `A-engine-compile`。
- **验收**：
  - Given 节拍引用不存在角色，When 校验，Then 阻断并定位字段，不得发布。
  - Given 可行动节拍无 fallback，When 编译，Then 返回 `MISSING_FALLBACK`。
  - Given 相同 revision 编译两次，Then checksum 与规则顺序一致。
  - Given 校验后草稿变化，When 发布，Then 强制重新校验。
- **Prototype**：`studio`；`studio.validate`, `studio.publish`。

### F-story-02 生成结构化下一节拍计划

- **Actor / 前置**：玩家会话绑定有效版本；请求含 expected turn 与幂等键。
- **触发 / 需求**：当预设或已初检自由行动到达时，系统应基于不可变版本和最后已提交状态生成 schema 合法的 `ScenePlan`：归一化意图、下一节拍、角色意图、状态差量提议、资产标签和解释代码。
- **规则**：计划无状态写权限；上下文受 token 预算限制且必须保留硬约束；`nextBeatId` 只来自允许迁移；默认不能创建新 NPC/道具；重复幂等请求复用结果。
- **状态**：accepted, clarifying, rejected, planning, retrying。
- **来源**：AI 假设 `A-engine-plan`。
- **验收**：
  - Given 当前只允许 B2/B3，When 模型返回 B9，Then 拒绝计划且状态不变。
  - Given 自由行动对象不明，When 置信度不足，Then 只问一个澄清问题且 turn 不增。
  - Given 同幂等键并发两次，Then 不启动第二个计划任务。
  - Given 上下文超预算，Then 摘要最近回合但保留所有硬约束和当前状态。
- **Prototype**：`play`；`play.preset-choice`, `play.free-action`。

### F-story-03 生成可渲染场景载荷

- **Actor / 前置**：`ScenePlan` 已通过 schema、世界和角色检查。
- **触发 / 需求**：当计划 ACCEPT 时，系统应生成符合分级与角色语气的 `ScenePayload`，包括对白、旁白、字幕、下一行动和已登记资产引用；关键事实有文本等价物。
- **规则**：MVP 只选版本资产目录，不等待新视频；无匹配时用通用关键帧；预设行动 2–4 个；输出通过 schema 和安全检查，可修复错误最多重试一次。
- **状态**：writing, streaming, asset-fallback, safety-retry, ready。
- **来源**：AI 假设 `A-engine-render`。
- **验收**：
  - Given 计划含关键线索，When 生成，Then 线索同时存在于字幕/旁白字段。
  - Given 资产无匹配，Then 使用通用资产且叙事与行动完整。
  - Given 首次输出缺 choices，When 单次修复成功，Then 只发送有效载荷并记录 retry。
  - Given 输出违反分级，Then 不发客户端并进入 F-story-05。
- **Prototype**：`play`；`play.scene-stage`。

### F-story-04 原子提交状态并判定结局

- **Actor / 前置**：场景载荷和差量全部通过检查；expected turn 正确。
- **触发 / 需求**：当候选结果有效时，系统应在单个事务中写入审计、状态差量、新 turn 与载荷，再用提交后的状态确定性判定结局。
- **规则**：类型与范围必须合法；任一写入失败全部回滚；多结局按显式 priority；客户端收到 commitId 后才显示变化。
- **状态**：committing, committed, conflict, ending-hit, rolled-back。
- **来源**：AI 假设 `A-engine-state`。
- **验收**：
  - Given 关系范围 -3..3，When 差量导致 4，Then 回滚且 turn 不变。
  - Given 审计写入后数据库故障，Then 状态、turn、审计均无部分提交。
  - Given 两请求都期望 turn=4，When 首个提交，Then 第二个 conflict 并返回 turn=5。
  - Given E2 在提交后命中，Then 返回 E2 且不再生成普通选项。
- **Prototype**：`play.state-delta`, `ending.causal-trace`。

### F-story-05 安全、一致性与失败降级

- **Actor / 前置**：回合在意图、计划、写作、检查或提交阶段失败。
- **触发 / 需求**：当无法安全完成时，系统应保持最后已提交状态，并执行 CLARIFY、SAFE_MAP、REJECT、一次受控重试或版本内 FALLBACK，产生审计代码。
- **规则**：高风险文本不进入重试提示，只传策略代码；schema/轻微冲突最多修复一次；总预算用尽必须 fallback；状态 conflict 不重跑模型。
- **状态**：clarify, safe-map, rejected, retrying, fallback, recovered, terminal-error。
- **来源**：AI 假设 `A-engine-recovery`。
- **验收**：
  - Given 高风险输入，Then 安全拒绝/映射、turn 不变，日志只保留允许字段。
  - Given 模型连续超时，Then 总预算后返回预写兜底且可继续。
  - Given 计划冲突 hardNo 且修复仍失败，Then 不提交差量并 fallback。
  - Given 客户端重发已提交幂等键，Then 返回原 commitId，不推进新回合。
- **Prototype**：`play` 的澄清/拒绝/兜底态，`studio` 诊断。

## 非功能需求

### NFR-story-01 延迟与容量

接收反馈 P95 ≤ 2 秒、首个有效反馈 ≤ 6 秒、完整载荷 ≤ 12 秒；同 session 同时只能有一个 active turn。用 1,000 个代表性回合压测，按行动类型和模型路由报告 P50/P95/P99。

### NFR-story-02 一致性、安全与事务

100% 状态差量通过 schema、硬约束和安全检查；失败差量提交率为 0；所有提交使用 expected turn 与幂等键。验收覆盖红队、边界状态、数据库故障和并发重复请求。

### NFR-story-03 可追溯、隐私与复现

每个 commit 可追溯 version、turn、actionRef、contextChecksum、modelRoute、plan、checks、before/after、延迟和成本；不记录隐藏思维链，自由文本脱敏、限权、到期删除。随机抽 100 个 commit 均可回放状态变化。

## 非目标、风险与开放问题

- 非目标：运行时视频生成、开放世界、多人、跨作品记忆、模型训练。
- 风险：约束过强导致平庸（用节拍目的与风格样例）；变量爆炸（每类设上限）；fallback 重复（每节拍至少两种）；因果回顾编造（只用原因代码）。
- `[Open]` 是否允许显式授权 AI 创建临时 NPC/道具？
- `[Open]` 轻重模型路由依据与单章节成本预算是什么？
- `[Open]` P95 6/12 秒是否可接受，“稳妥推进”是否让玩家选择？
- `[Open]` 自由文本的留存期、脱敏与人工复核权限。
