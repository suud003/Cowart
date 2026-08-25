# 分岔回声｜交互与视觉基线

> 目标：让电影感与玩家掌控感同时成立；生成等待、规则边界和状态变化可理解，但不把玩家界面做成调试器。具体风格与数值均为 AI 假设。

## 体验原则

1. **先给结果感**：提交后 100ms 内反馈，AI 阶段以简短、非虚假进度呈现。
2. **一个镜头，一个决定**：行动节点才突出操作，预设行动为主、自由行动渐进展开。
3. **后果有证据**：只展示已提交的关系、线索和目标变化。
4. **边界属于世界**：先解释不可行原因，再给世界内可执行替代。
5. **创作与游玩同源**：Studio 的规则/状态命名与 Play 诊断和反馈一致。

## 视觉 tokens

| Token | Value | 用途 |
|---|---:|---|
| `--ink-strong` | `#17181B` | 主文本 / 深色按钮 |
| `--ink-muted` | `#71747D` | 次级说明 |
| `--surface` | `#FAF9F6` | 工作室背景 |
| `--surface-raised` | `#FFFFFF` | 卡片 / 表单 |
| `--cinema` | `#111318` | 播放区背景 |
| `--cinema-soft` | `#1B1E26` | 深色面板 |
| `--accent` | `#F36B3F` | 主行动、关键回合 |
| `--clue` | `#48A9A6` | 线索 / 已验证事实 |
| `--success` | `#2F855A` | 保存 / 发布成功 |
| `--warning` | `#B7791F` | 可继续警告 |
| `--danger` | `#C2413B` | 阻断 / 红线 |
| `--border` | `#D9D7D1` | 浅色边框 |
| `--focus` | `#246BFE` | 键盘焦点 |

- 字体：`Inter, PingFang SC, Microsoft YaHei, system-ui, sans-serif`；数字用 tabular numbers。
- 文本对比度达 WCAG 2.2 AA；状态需有图标/文字，不只靠颜色。
- 按钮圆角 10px、卡片 14px；以边框、层级色和留白为主，仅浮层用阴影。

## 页面布局

- 评审基准 1280×800，主内容 max-width 1200px；1024px 可完成主流程；小于 768px 单列。
- **Discover**：左侧氛围画面，右侧标题、分级、时长、玩法边界和主 CTA。
- **Play**：电影画面占 65–72%，行动面板右置或下置；HUD 仅保留当前目标、关键关系和新增线索。
- **Ending**：收束画面 → 3–5 个真实因果节点 → 终态 → 重新游玩。
- **Studio**：项目结构 / 编辑器 / 校验诊断三栏；1280px 以下诊断折叠为抽屉。

## 核心组件

### ActionChoice

- 显示序号、行动标题与可选风险提示。
- 状态：default, hover, focus, selected, submitting, disabled, unavailable。
- `selected` 仅代表本地选择，收到 commit 后才切换场景。

### FreeActionComposer

- 默认收起；展开后保持焦点，Ctrl/Cmd+Enter 提交，Esc 收起但保留文本。
- 空值禁用、超长显示剩余字数；澄清只问一个问题并给建议回答。

### GenerationProgress

- 文案：“听见了你的行动” → “角色正在权衡” → “场景正在展开”。
- 不用虚假百分比；超过 6 秒显示等待/兜底状态；减少动态模式关闭闪烁与大幅运动。

### StateDelta

- 只显示已提交变化，如“林默的信任 +1”“获得线索：倒放录音”。
- 单回合最多直显 3 项，其余折叠；隐藏状态不可泄露。

### ValidationIssue / BeatNode

- 问题含严重级别、对象、原因、修复建议与定位操作。
- 节拍显示目的、前置条件、出口、兜底和资产覆盖；图形关系必须有等价列表视图。

## 共享状态

| 状态 | 玩家端 | Studio |
|---|---|---|
| Default | 场景 / 行动可用 | 草稿可编辑 |
| Focus | 2px focus ring | 可跳到错误 |
| Loading | 保留上一场景并显示阶段 | 局部保存/校验 loading |
| Empty | 无章节 / 无行动引导 | 新项目 checklist |
| Validation error | 原因 + 可行替代 | 字段级 + 问题列表 |
| Service error | 当前状态保留，可重试/兜底 | 本地变更保留 |
| Success | 新场景 + committed 反馈 | 已保存 / 校验通过 / 已发布 |
| Unauthorized | 不泄露会话细节 | 无权限 + 返回入口 |
| Conflict | 恢复服务端最新 turn | 比较 revision，不静默覆盖 |

## 动效、媒体与无障碍

- 镜头切换 180–320ms，文本/选项 120–200ms；支持减少动态。
- 遵守自动播放规则；提供字幕、音量、静音和对白重放。
- 全键盘完成主流程；焦点顺序与视觉一致，弹层关闭后焦点返回触发器。
- 关键音效和视觉线索均有文本等价物；流式文本用 `aria-live=polite` 分段播报。
- 中文/英文按 1.5 倍文案长度压力测试，不把唯一文字嵌入图片。

## 稳定标注锚点

- 使用 `data-annotation-key`，不依赖绝对屏幕坐标。
- 建议键：`discover.start-session`、`play.scene-stage`、`play.preset-choice`、`play.free-action`、`play.state-delta`、`ending.causal-trace`、`studio.world-rules`、`studio.beat-graph`、`studio.validate`、`studio.publish`。
- 标注附着元素边界的百分比点并带 8–12px offset；响应式换行后跟随目标。
- 目标隐藏时标注同步隐藏或迁移到等价移动端控件，禁止悬浮在旧坐标。

## 验收清单

- [ ] 1280×800、1024×768 无遮挡、截断或标注漂移。
- [ ] 375×812 能完成 Discover → Play 行动 → Ending。
- [ ] loading、澄清、拒绝、超时兜底与断网恢复可演示。
- [ ] 键盘、焦点、对比度、字幕与减少动态通过。
- [ ] 状态变化只在服务端 commit 后出现。
- [ ] Studio 阻断问题可定位并给出可执行修复建议。
