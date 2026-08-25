# 分岔回声｜模块计划

> 用于组织评审、原型与 Yogurt AI 画布分区。除“AI 互动影游 case”外均为 AI 假设。

## 模块地图

| 模块 ID | 责任边界 | 页面 / 表面 | Requirement IDs | Yogurt 分区 | 依赖 |
|---|---|---|---|---|---|
| `story-engine` | 约束编译、叙事计划、校验、状态提交与降级 | Studio 诊断、Play 生成态 | F-story-01..05, NFR-story-01..03 | `zone-story-engine` | 安全、模型、状态库、资产目录 |
| `player-experience` | 章节发现、电影化播放、行动、反馈、结局 | `discover`, `play`, `ending` | F-play-01..06, NFR-play-01..03 | `zone-player-loop` | story-engine、身份、媒体播放 |
| `creator-studio` | 世界/角色/红线/节拍/结局、预览与发布 | `studio` | F-studio-01..05, NFR-studio-01..03 | `zone-creator-studio` | 编译器、版本与审批 |

## 依赖关系

```text
Creator Studio ─产出→ StoryVersion（约束包 + 节拍图 + 资产目录）
                            ├─读取→ Player Experience
                            └─读取→ AI Story Engine
Player Experience ─行动→ AI Story Engine ─校验/生成/提交→ SessionState
                  ← ScenePayload + committed state
```

## MVP 里程碑

### M0 · 规格与风险闭环

- 确认用户、分级、时长、自由行动入口、延迟与成本预算。
- 冻结 `StoryVersion`、`SessionState`、`ScenePlan` 和状态差量 schema。
- 用 20 个冲突/违规/超时样例验证执行、澄清、安全映射、拒绝。

### M1 · 确定性竖切

- 完成 5 回合、2 结局的硬编码故事，不接 LLM。
- 打通 Studio 发布 → Discover 建会话 → Play 提交 → Ending 回顾。
- 验证幂等、刷新恢复、下架和资产失败降级。

### M2 · 受约束 AI 回合

- 接入意图解析、结构化计划与对白生成。
- 实现规则优先级、单次修复重试、确定性兜底和审计。
- 使用预生成资产标签，不接运行时视频生成。
- 内测退出门槛：100 局硬冲突率 < 1%，非法状态提交为 0，P95 首反馈 ≤ 6 秒。

### M3 · 完整 case

- 扩展到 20–30 分钟、3 个主结局 + 1 个安全收束结局。
- 5 名创作者、20 名玩家完成可用性测试并校准完成率、自由行动成功率、延迟和成本。

## 页面覆盖

| 页面 | 关键任务 | 关键状态 | Requirement |
|---|---|---|---|
| `discover` | 理解玩法、分级、时长并开始 | default, creating, unavailable, error | F-play-01 |
| `play` | 观看、行动、理解反馈 | ready, submitting, clarifying, rejected, fallback, resumed | F-play-02..05, F-story-02..05 |
| `ending` | 理解结局因果、重新开始 | loading, complete, partial-audit, error | F-play-06 |
| `studio` | 定义、校验、预览、发布 | draft, dirty, validating, blocked, preview, published, conflict | F-studio-01..05, F-story-01 |

## 评审顺序

1. 产品边界：用户、范围、非目标和成功标准。
2. 状态模型：实体、规则优先级、原子提交与结局判定。
3. 玩家体验：电影感与等待、自由输入边界、反馈密度。
4. 创作者体验：约束可理解性、校验修复、版本权限。
5. AI / 安全：红队集、审计、隐私和下架。
6. 工程可行性：模型路由、性能、成本、资产和降级。

## 当前待决策

- [Pending] 是否确认三模块为 MVP 边界。
- [Pending] Studio 是单页工作台还是拆为世界、节拍、预览三页。
- [Pending] 关系/线索反馈采用常驻 HUD、回合 toast，还是只在关键节点显示。
- [Pending] Yogurt 首轮采用“输入与假设 / 核心循环 / 三模块 / 风险与决策 / PRD 入口”分区。
