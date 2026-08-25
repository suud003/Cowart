# 玩家体验 PRD

> Module ID: `player-experience` · Status: draft · Case: 分岔回声
> 用户只确认“AI 互动影游 case”；画像、页面、指标和规则均为 AI 假设。

## 目标与指标

让轻度玩家在 1 分钟内理解玩法，通过预设选择或一句自然语言行动改变电影化故事，并在结局明确感知关键决策的影响。

- 章节页到会话开始转化 ≥ 60%；开始后结局完成率 ≥ 55%。
- 完成者认为“选择明显改变故事”的 4–5 分占比 ≥ 70%。
- 自由行动直接执行或一次澄清后执行比例 ≥ 75%。
- 完成会话有效回合中位数 ≥ 8；因等待退出比例 < 10%。

范围包括章节介绍、创建/恢复会话、播放、预设/自由行动、AI 等待/澄清/拒绝/兜底、状态反馈、结局回顾与重玩。不包括多人、实时语音、复杂战斗、UGC、长期养成、付费社交和运行时视频生成。

## 功能需求

### F-play-01 理解章节并开始版本绑定会话

- **前置 / 触发**：玩家打开已发布且未下架的章节，选择“开始故事”。
- **需求**：系统应展示标题、简介、内容分级/敏感提示、预计时长、互动方式和无障碍设置；确认后创建绑定当前 `StoryVersion` 的会话。
- **规则**：说明可选预设或自由行动及其边界；年龄/地区/登录门槛先执行；重复点击只建一个 session；有未完成会话时显示继续/重开。
- **状态**：default, creating, resume-available, unavailable, age-gated, service-error。
- **来源**：AI 假设 `A-player-entry`。
- **验收**：
  - Given 可用章节，Then 分级、时长、边界和 CTA 可见、键盘可达。
  - Given 双击开始，Then 只创建一个绑定唯一 versionId 的 session。
  - Given 版本下架，Then CTA 禁用并说明，不创建会话。
  - Given 有未完成会话，Then“继续”恢复原 session，“重开”新建且不删除旧记录。
- **Prototype**：`discover.start-session`。

### F-play-02 呈现电影化场景与行动节点

- **前置 / 触发**：会话当前回合载荷就绪或恢复完成。
- **需求**：系统应播放预生成视觉资产、同步字幕/旁白；到行动节点后暂停并显示当前目标、2–4 个预设行动和自由行动入口。
- **规则**：播放时不提前露出选择；关键事实有文本等价；资产失败用通用关键帧；支持暂停、重放对白、字幕、音量和减少动态。
- **状态**：loading, playing, paused, action-ready, asset-fallback, recovered。
- **来源**：AI 假设 `A-player-scene`。
- **验收**：
  - Given 未到行动节点，Then 选项不可误触且字幕可用。
  - Given 到达节点，Then 2–4 个行动与自由入口按焦点顺序出现。
  - Given 主视频失败，Then 通用关键帧、完整字幕和行动仍可用。
  - Given 减少动态开启，Then 无推镜/晃动且功能完整。
- **Prototype**：`play.scene-stage`。

### F-play-03 提交预设行动并防止重复推进

- **前置 / 触发**：行动节点 ready；玩家点击或键盘选择预设行动。
- **需求**：系统应在 100ms 内标记选择，携带 turn 和幂等键发送请求，锁定重复提交，并在服务端确认后推进且只推进一个回合。
- **规则**：提交中其他选项 disabled 但可读；过期 turn 恢复最新场景；网络失败保留语义并重试同一幂等请求；无后端取消能力不显示取消。
- **状态**：ready, selected, submitting, committed, network-error, stale-turn。
- **来源**：AI 假设 `A-player-choice`。
- **验收**：
  - Given ready，When 点击，Then 100ms 内反馈且其他选项不可再交。
  - Given 双击/浏览器重试，Then 只产生一个 turn 和 commitId。
  - Given 提交断网后重试，Then 保持幂等键且只推进一次。
  - Given 客户端 turn 过期，Then 恢复最新场景并说明旧行动未重跑。
- **Prototype**：`play.preset-choice`。

### F-play-04 提交并处理自由行动

- **前置 / 触发**：章节允许自由行动，玩家在行动节点提交非空文本。
- **需求**：系统应验证长度/安全、解析动作/对象/目标，将结果呈现为 ACCEPT、CLARIFY、SAFE_MAP 或 REJECT；只有接受或经确认的安全映射推进回合。
- **规则**：MVP 假设最多 200 字；澄清最多一轮且一个问题；SAFE_MAP 默认需确认；REJECT 状态不变并给至少两个替代项，不复述有害文本。
- **状态**：editing, validating, accepted, clarifying, safe-map-confirm, rejected, error。
- **来源**：AI 假设 `A-player-free-action`。
- **验收**：
  - Given 空输入，Then 不发请求、焦点保留并显示错误。
  - Given 世界内可行行动，Then ACCEPT 推进并记录 normalizedIntent。
  - Given 对象不明，Then 一个澄清问题且 turn 不增。
  - Given 不安全行动，Then REJECT、状态不变且给安全替代。
- **Prototype**：`play.free-action`。

### F-play-05 展示已提交的状态变化

- **前置 / 触发**：回合收到 commitId 且有玩家可见变化。
- **需求**：系统应以不打断叙事的方式显示关系、线索或目标变化，并允许查看完整回合记录。
- **规则**：候选差量绝不显示；一回合最多直显 3 项；隐藏状态不泄露；每项含标签、方向/新值和来源回合。
- **状态**：no-visible-change, delta-toast, expanded-log, clue-detail。
- **来源**：AI 假设 `A-player-feedback`。
- **验收**：
  - Given commit 含信任 +1 与新线索，Then 两项显示且可追到回合。
  - Given 候选差量提交失败，Then 客户端不显示。
  - Given 5 项变化，Then 直显 ≤3 并提供键盘可达完整列表。
  - Given 隐藏秘密，Then记录页不泄露。
- **Prototype**：`play.state-delta`。

### F-play-06 展示可解释结局并支持重玩

- **前置 / 触发**：提交后状态命中确定性结局。
- **需求**：系统应呈现结局场景、标题、3–5 个有结构化回合证据的因果节点、关系/线索终态和重新游玩入口。
- **规则**：不展示思维链；证据不足时显示最小结局，不补造因果；重玩新建 session；不默认剧透其他结局条件。
- **状态**：loading, complete, partial-trace, service-error, replay-creating。
- **来源**：AI 假设 `A-player-ending`。
- **验收**：
  - Given 命中 E2，Then 无普通下一选项并显示真实因果节点。
  - Given 只有两个有效原因，Then 只显示两个，不补造第三个。
  - Given 重玩，Then 新建 session 且旧状态不变。
  - Given 回顾服务失败，Then 保留结局标题与重试入口。
- **Prototype**：`ending.causal-trace`。

## 非功能需求

### NFR-play-01 响应与感知性能

本地反馈 ≤100ms；提交后 2 秒内显示接收反馈；等待不用虚假百分比，超过 6 秒显示继续等待/兜底状态。中端移动端和桌面各测试 30 次主流程，记录 INP、首反馈、完整载荷及等待退出。

### NFR-play-02 无障碍与适配

键盘可完成 Discover → Play → Ending；焦点可见、弹层正确返回，文本达 WCAG 2.2 AA；视频有字幕，关键视听线索有文本；支持减少动态。375×812、1024×768、1280×800 无主流程遮挡。

### NFR-play-03 会话恢复与正确性

刷新或断网后恢复最后已提交 turn；未提交文本明确标记；重复请求不重复推进。分别在提交前、处理中、提交后三时点做 20 次断网/刷新，重复或丢失有效回合为 0。

## 风险、开放问题与非目标

- 风险：HUD 破坏沉浸（只显关键变化）；自由输入被理解为无限能力（示例与边界）；等待拟人化误导（只描述阶段）；结局解释剧透（只讲已发生因果）。
- `[Open]` 自由行动默认展开还是次级入口？
- `[Open]` 状态反馈常驻、toast 还是仅关键回合；能否关闭？
- `[Open]` 是否支持游客与跨设备恢复？
- `[Open]` 结局分享如何避免泄露自由文本和剧透？
- 非目标：多人、语音、战斗、UGC、长期养成、社交与付费。
