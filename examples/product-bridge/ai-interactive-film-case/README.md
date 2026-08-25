# 分岔回声｜AI 互动影游 Product Bridge 案例

这是一个从一句模糊产品想法出发，经过 `Yogurt AI → Product Bridge → PRD 与交互原型 → 评审 → 确认后回流 Yogurt` 的完整案例。

唯一初始输入是：把 PRD 生成与 Yogurt AI 打通，并用“AI 互动影游”做一个 case。本案例没有读取 TAPD；故事设定、目标用户、指标和商业判断均为演示用 AI 假设，不代表已确认需求。

> 能力边界已经纠正：Product Bridge 只负责产品文档、交互原型、标注和产品分区回流。html-line-svg 的画图与布局能力属于独立的 [Yogurt 画布框线图案例](../../semantic-diagram/ai-interactive-film-system/)，不会自动进入本工作区。

## 结果一览

| 维度 | 实际产物 |
| --- | --- |
| 产品结构 | 4 份 shaping 文档、3 份模块 PRD、1 份体验与视觉基线 |
| 评审工作区 | 2 个交互模块、5 个真实原型页面、14 个稳定标注锚点 |
| 交互原型 | 作品发现、互动播放、可解释结局、故事编排、发布检查 |
| 页面关系 | 5 个原型页面及可执行跳转，不包含语义图页面 |
| Yogurt 回流 | 6 个产品分区、26 张分区内卡片、12 条关系；语义图不进入 Bridge trace map |
| 验证结果 | Product Bridge 严格校验无错误；标注浏览器实测最大漂移 0.01px |

## 1. 页面关系：看真实原型如何串起来

Product Bridge 把 5 个真实原型页面及其跳转关系放进可缩放的“页面关系”视图。关系线区分主路径、备选路径和模块间依赖；页面卡片仍是真实原型缩略图，不是语义框线图，也不是重画的静态示意图。

![分岔回声 Product Bridge 页面关系，展示五个真实原型页面](docs/images/product-bridge-global-canvas.png)

这个视图只回答产品页面与导航问题。系统架构、概念关系或教学型框线图由 Yogurt 的独立画布入口生成。

## 2. 两个菜单入口并行，不会互相自动触发

Yogurt AI 菜单中有两个独立动作：

![Yogurt AI 菜单中的生成交互 PRD 与生成画布框线图入口](docs/images/yogurt-new-actions.png)

- `生成交互 PRD`：把文字叙述、Yogurt 内容和可访问的外部需求材料整理成 Product Bridge 工作区。
- `生成画布框线图`：把同一选区直接整理成当前 Yogurt 页面上的原生节点、语义分区与关系线。
- 两个动作可读取同一份冻结来源，但拥有独立的产物、operation ID 与 trace；Product Bridge manifest 不注册语义图。
- TAPD URL 只有在授权连接器确实返回正文后才算已读取；本插件不内置 TAPD 登录连接器，也不会根据 URL 猜测需求。

## 3. 评审与标注：标记绑定真实控件

评审视图把交互原型、模块 PRD 和页面标注放在同一屏。下图中的 1–4 号标记分别绑定场景、预设选择、自由行动和状态账本对应的 `data-annotation-anchor`。

![互动播放原型、玩家体验 PRD 与四个稳定语义标注同屏评审](docs/images/product-bridge-review.png)

标注位置依据 iframe 与目标元素的实际矩形实时计算，并处理独立缩放和坐标系转换。页面尺寸或布局改变后，标记跟随语义元素，而不是停留在旧截图位置。

## 4. 可交互原型：选择、自由行动和状态账本形成闭环

玩家端不是一组静态稿。预设行动和自由输入会确定性地更新角色信任、线索与叙事承诺；完成两轮选择后可进入由状态账本解释的分支结局。

![AI 互动影游的互动播放页，展示场景、状态账本和分支结局入口](docs/images/interactive-player.png)

- [作品发现与开场](prototypes/discover.html)
- [互动播放](prototypes/play.html)
- [可解释结局](prototypes/ending.html)
- [故事编排](prototypes/studio.html)
- [发布与安全检查](prototypes/review.html)

## 5. 回流 Yogurt：只返回产品结构

Product Bridge 回流把评审结果转换为真正的 Yogurt 产品分区、分区内卡片和关系。旧的系统框线图卡片与 `system-overview` 页面映射已经从当前工作区清理；最新边界收口只更新“PRD 与交互原型评审”产品分区，批次中没有 `semanticDiagram`。独立原生语义图由另一条 canvas operation 创建，不写入本案例的 manifest 或 trace map。

初次回流遵循 `读取 revision → dry-run → 明确确认 → 原子应用`。最新 Product Bridge-only 边界操作为 `20260825043143046-31627d4c`，从 revision `308da9ea792c28b665db` 更新到 `f5b7bb6c35023e84fa91`。[return-preview.json](bridge/return-preview.json) 只保存这次不可重放的最小审计记录，不再携带旧 operations 或任何原生语义图 ID。

## 文件索引

| 路径 | 内容 |
| --- | --- |
| [`shaping/`](shaping/) | 产品 Brief、EARS 风格需求、玩家/创作者流程与模块计划 |
| [`prd/`](prd/) | AI 叙事引擎、玩家体验、创作者工作室三份模块 PRD |
| [`prototypes/`](prototypes/) | 5 个自包含、可离线交互的 HTML 页面 |
| [`bridge/source-packet.json`](bridge/source-packet.json) | 用户输入、能力边界澄清、来源状态、AI 假设与待确认问题 |
| [`bridge/trace-map.json`](bridge/trace-map.json) | 来源 → 需求 → 页面/标注 → Yogurt 产品分区与返回 shape 的映射 |
| [`bridge/return-preview.json`](bridge/return-preview.json) | Product Bridge-only 边界收口的最小审计记录，不含旧回流 operations |
| [`bridge/sync-state.json`](bridge/sync-state.json) | 初次回流与边界修正的 revision、operation ID |
| [`interaction-prd.json`](interaction-prd.json) | 文档、真实原型页面、跳转位置与稳定标注锚点 |

## 本地运行

从 Cowart 插件仓库根目录执行：

```powershell
python -B -X utf8 skills/cowart-product-bridge/scripts/validate_workspace.py examples/product-bridge/ai-interactive-film-case --strict
python -B -X utf8 skills/cowart-product-bridge/scripts/serve.py examples/product-bridge/ai-interactive-film-case
```

打开服务输出的本地地址后：

1. 在 `文档与原型` 中切换模块和页面，显示或隐藏稳定标注。
2. 切换到 `页面关系` 查看 5 个真实原型及其导航，可拖动页面并自动保存位置。
3. 点击 `编辑源文件` 回到对应 PRD 或原型；这里不会出现语义图文件。
