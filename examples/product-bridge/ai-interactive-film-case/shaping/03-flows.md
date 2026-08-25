# 分岔回声｜流程与状态

> 所有具体流程均为 AI 假设。本文件用于让 PRD、原型与测试共享同一条业务链路。

## 1. 端到端主流程

```text
创作者建稿 → 定义世界/角色/红线 → 编排关键节拍与结局
  → 预览并修复阻断问题 → 发布不可变 StoryVersion
  → 玩家查看章节并创建 Session → 播放初始场景
  → 玩家选择 / 自由行动 → AI 导演计划 → 规则与安全校验
  → 生成场景 → 原子提交状态 → 呈现后果
  → 重复回合直至命中结局 → 因果回顾 / 重新游玩
```

## 2. 创作者发布流程

1. 新建项目，填写标题、题材、语言、内容分级与目标时长。
2. 定义 `WorldBible`：时间、地点、事实与不能被 AI 改写的硬规则。
3. 定义角色：目标、隐藏动机、说话风格、关系轴与不可违背行为。
4. 配置作品红线与自由行动的拒绝/安全映射策略。
5. 绘制节拍图：开场、必经/可选节拍、汇流点、兜底节拍与结局条件。
6. 为节拍绑定预生成视觉资产标签；关键事实同时提供字幕或旁白。
7. 发起校验：编译约束，检查引用、可达性、冲突、兜底和资产覆盖。
8. 用隔离测试会话预览至少一条完整路径，查看状态差量和规则诊断。
9. 当前 revision 的阻断项清零后发布不可变 `StoryVersion`；内容审批后可建玩家会话。

### 校验与版本例外

- 字段问题定位到字段；图问题高亮不可达、死循环、结局冲突或缺失兜底。
- 关键事实只有视觉承载时阻断；一般氛围资产缺失只警告。
- 草稿采用 revision；保存冲突不得覆盖另一版本。
- 校验后草稿发生变化，旧结果失效；已发布版本不可编辑，后续修改生成新草稿。

## 3. 玩家主流程

### 进入章节

1. 查看简介、内容分级、预计时长、自由行动说明和无障碍选项。
2. 选择“开始故事”，服务端绑定当前 `StoryVersion` 并创建 `SessionState(turn=0)`。
3. 预载开场镜头与字幕；视觉加载失败时以静态关键帧 + 文本开始。

### 回合循环

1. 播放当前场景；到可行动节点后暂停并显示 2–4 个预设行动与自由行动入口。
2. 玩家提交；客户端立即确认接收、锁定重复提交，并携带 `idempotencyKey`。
3. 服务端检查会话版本和 turn，解析行动，生成结构化计划。
4. 规则服务验证计划、内容与状态差量。
5. 通过后生成对白/旁白、匹配视觉资产并原子提交新状态。
6. 客户端先显示阶段反馈，再呈现匹配镜头；状态确认后才显示关系/线索变化。
7. 命中结局则停止普通下一选项并进入 Ending；否则开始下一回合。

### 自由行动分流

```text
玩家文本 → 基础合法性 / 安全检查 → 结构化意图解析 → 世界与状态可行性检查
  ├─ ACCEPT：执行并进入正常计划
  ├─ CLARIFY：只问一个澄清问题，不推进 turn
  ├─ SAFE_MAP：说明安全替代，默认经玩家确认后执行
  └─ REJECT：说明边界、保持状态、提供可行的预设行动
```

- 澄清最多一次；仍不清楚时退回预设行动。
- 只展示世界内解释与规则结果，不显示模型隐藏思维链。

## 4. AI 导演单回合时序

| 顺序 | 组件 | 输入 | 输出 / 检查点 |
|---:|---|---|---|
| 1 | Session API | sessionId, turn, action, idempotencyKey | 鉴权、版本与幂等校验 |
| 2 | Intent Parser | raw action, world summary | normalizedIntent / CLARIFY / REJECT |
| 3 | Context Builder | StoryVersion, SessionState, recent summary | 有预算且保留硬约束的上下文 |
| 4 | Story Planner | context, intent, allowed beats | `ScenePlan`，无状态写权限 |
| 5 | Constraint Engine | plan, hard rules, state schema | ACCEPT / violations / fallback reason |
| 6 | Scene Writer | accepted plan, style, asset catalog | dialogue, narration, choices, assetTags |
| 7 | Safety + Schema | scene payload, delta | allow / block / retry once |
| 8 | State Store | expectedTurn, validated delta | 原子 commit，生成 newTurn |
| 9 | Client Stream | committed payload | 场景、状态反馈、下一组行动 |

只有第 8 步成功才算完成回合。候选内容不得提前显示“获得线索”或“关系 +1”。

## 5. 结局与因果回顾

1. 使用提交后的状态计算结局条件。
2. 多结局命中按 `EndingRule.priority` 选择；同优先级属于发布阻断错误。
3. 结局页显示收束场景、3–5 个关键因果节点、关系/线索终态和重新游玩。
4. 因果节点来自结构化回合审计，不用事后无依据生成。
5. 重新游玩创建新 session；旧 session 保留只读。

## 6. 降级与恢复

### 模型慢 / 超时

- 2 秒内显示确定性接收反馈，6 秒前优先返回流式文字或阶段提示。
- 单次预算用尽后只对可重试错误重试一次；总预算用尽后使用版本内预写 fallback。
- 任何超时均不得提交模型的部分状态差量。

### 不一致 / 不安全

- 阻止候选计划和差量；可修复 schema/轻微冲突最多重试一次。
- 高风险事件只把策略代码和安全摘要传入处理链，不回传原有害文本。
- 仍失败则走确定性兜底并按策略进入运营复核。

### 刷新 / 断网 / 状态冲突

- 服务端是已提交回合的唯一事实源；恢复时读取最新 turn 和场景。
- 未发送自由文本可临时保存在本地并标记“未提交”，不得无限期保存。
- 客户端落后一回合时恢复服务端结果，不再次运行模型。

### 资产失败

- 使用章节内通用关键帧；保留字幕、旁白与行动可用性，不阻塞叙事状态。

## 7. 页面状态矩阵

| 页面 | Default | Loading | Empty | Validation / Error | Success | Unauthorized |
|---|---|---|---|---|---|---|
| Discover | 章节信息与 CTA | 创建会话中 | 无可用版本 | 下架 / 网络失败 | 进入 Play | 年龄、登录或地区提示 |
| Play | 场景 + 行动 | AI 阶段提示、禁重复提交 | 无动作走节拍兜底 | 冲突、拒绝、澄清、超时 | 新场景与状态反馈 | 隐藏他人会话 |
| Ending | 结局与因果链 | 加载摘要 | 审计缺失显示最小结局 | 回顾失败但结局保留 | 可重新游玩 | 隐藏他人结局 |
| Studio | 草稿编辑 | 保存 / 校验 / 发布 | 新项目引导 | 字段、图、资产、安全错误 | 已保存 / 可预览 / 已发布 | 无项目权限 |

## 8. 埋点建议

- `chapter_viewed`, `session_started`, `scene_presented`
- `preset_action_submitted`, `free_action_submitted`, `action_clarified`, `action_safe_mapped`, `action_rejected`
- `turn_first_feedback`, `turn_committed`, `turn_fallback_used`, `turn_failed`
- `relationship_changed`, `clue_unlocked`, `ending_reached`, `replay_started`
- `studio_validation_started`, `studio_validation_failed`, `preview_completed`, `version_published`

事件携带 `storyVersionId`、匿名 session、turn、resultCode、latencyBucket；自由文本不得直接进入通用分析事件。
