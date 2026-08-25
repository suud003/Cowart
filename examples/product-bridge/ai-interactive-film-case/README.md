# 分岔回声｜把产品想法变成可评审、可交互的 AI 影游方案

“分岔回声”展示了 Yogurt AI Product Bridge 的完整体验：把散落在画布里的产品想法、文字描述和外部需求链接，整理成结构化 PRD、可直接操作的交互原型和统一评审空间，再把确认后的产品结构带回 Yogurt 画布继续思考。

![分岔回声 Product Bridge 评审空间，展示互动播放原型、PRD 与稳定标注](docs/images/product-bridge-review.png)

## 从一个想法到一套产品方案

本案例以“做一款 AI 互动影游”为输入。演示素材没有导入 TAPD 正文；故事设定、目标用户、指标和商业判断均标记为待确认的 AI 假设，方便体验完整流程，又不会把推测包装成真实需求。

| Product Bridge 帮你完成 | 本案例中的可见结果 |
| --- | --- |
| 梳理零散信息 | 4 份产品塑形文档、3 份模块 PRD、1 份体验与视觉基线 |
| 把需求变成体验 | 作品发现、互动播放、可解释结局、故事编排、发布检查 5 个可交互页面 |
| 集中产品评审 | 2 个交互模块、14 个跟随真实控件的稳定标注锚点 |
| 看清页面关系 | 5 个原型页面及其主路径、备选路径与模块依赖 |
| 回到画布继续工作 | 6 个产品分区、26 张分区内卡片和 12 条关系 |
| 保留来源线索 | 输入、假设、需求、页面、标注与 Yogurt 对象之间可追溯 |

## 在一个工作区里完成理解、体验和评审

### 1. 先读懂产品

Product Bridge 会把输入整理为产品 Brief、EARS 风格需求、玩家与创作者流程、模块计划，以及 AI 叙事引擎、玩家体验和创作者工作室三份模块 PRD。事实、外部链接状态、AI 假设和待确认问题分别记录，便于团队继续补充真实材料。

### 2. 再直接操作核心体验

玩家端不是静态截图。预设行动和自由输入会更新角色信任、线索与叙事承诺；完成两轮选择后，可以进入由状态账本解释的分支结局。

![AI 互动影游的互动播放页，展示场景、状态账本和分支结局入口](docs/images/interactive-player.png)

- [作品发现与开场](prototypes/discover.html)
- [互动播放](prototypes/play.html)
- [可解释结局](prototypes/ending.html)
- [故事编排](prototypes/studio.html)
- [发布与安全检查](prototypes/review.html)

### 3. 让标注意见始终指向真实控件

评审标记绑定页面中的语义锚点，而不是截图坐标。页面缩放或布局变化后，标记仍会跟随对应的场景、选择器、自由行动输入框和状态账本，方便产品、设计和研发围绕同一处交互讨论。

### 4. 用页面关系快速检查完整链路

“页面关系”把 5 个真实原型及其跳转放在一张可缩放视图里。页面卡片可以拖动，主路径、备选路径和模块依赖一目了然。

![分岔回声页面关系，展示五个真实原型页面及其导航](docs/images/product-bridge-global-canvas.png)

### 5. 把确认后的结构带回 Yogurt

完成评审后，可以先预览将要写回的产品分区、卡片和关系，确认后再同步到 Yogurt。这样，PRD 与原型中的结论能够回到原来的思考空间，继续与新材料一起演化。

## 如何体验

从 Cowart 插件仓库根目录执行：

```powershell
python -B -X utf8 skills/cowart-product-bridge/scripts/validate_workspace.py examples/product-bridge/ai-interactive-film-case --strict
python -B -X utf8 skills/cowart-product-bridge/scripts/serve.py examples/product-bridge/ai-interactive-film-case
```

打开服务输出的本地地址后：

1. 在 `文档与原型` 中切换模块和页面，操作原型并显示或隐藏评审标注。
2. 切换到 `页面关系`，查看完整导航链路并拖动页面调整视图。
3. 从任意文档或原型使用 `编辑源文件`，继续完善需求与交互。

## 可验证产物

| 路径 | 内容 |
| --- | --- |
| [`shaping/`](shaping/) | 产品 Brief、EARS 风格需求、角色流程与模块计划 |
| [`prd/`](prd/) | AI 叙事引擎、玩家体验、创作者工作室三份模块 PRD |
| [`prototypes/`](prototypes/) | 5 个自包含、可离线交互的 HTML 页面 |
| [`interaction-prd.json`](interaction-prd.json) | 工作区模块、真实页面、导航和稳定标注配置 |
| [`bridge/source-packet.json`](bridge/source-packet.json) | 原始输入、来源访问状态、AI 假设与待确认问题 |
| [`bridge/trace-map.json`](bridge/trace-map.json) | 来源到需求、页面、标注及 Yogurt 产品对象的映射 |

想把同一组材料整理成可编辑的系统关系图，可以继续体验配套的 [Yogurt 画布原生框线图案例](../../semantic-diagram/ai-interactive-film-system/)。
