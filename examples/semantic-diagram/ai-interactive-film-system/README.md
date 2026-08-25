# AI 互动影游｜把复杂产品关系直接画进 Yogurt

这个案例展示 Yogurt AI 的画布原生框线图能力：选中零散材料，AI 会提炼核心判断、对象、关系、状态和阅读顺序，并在当前画布上生成一张可以继续移动、改字、连接和扩展的结构图。

![AI 互动影游系统框线图直接生成在 Yogurt AI 画布上](yogurt-semantic-diagram-on-canvas.png)

## 一次生成，得到可继续编辑的产品结构

案例围绕一个核心判断组织信息：

> AI 互动影游不是自由生成：创作者约束与安全闸门控制 AI 导演，玩家行动只在可追踪状态内推动下一幕。

Yogurt 将这个判断展开为创作者约束、叙事编译器、玩家行动、安全与成本闸门、AI 导演、状态账本、下一幕与可解释结局 7 个节点，并用 6 条有方向、有语义的关系连接起来。

| 能力 | 画布上的效果 |
| --- | --- |
| 原生编辑 | 语义分区、7 张卡片和 6 条关系线都能单独选择与修改 |
| 自动布局 | 根据阅读顺序组织层级，并处理循环关系、标签间距和节点避让 |
| 语义连线 | 主路径、备选路径、同步与关联使用一致的线型、箭头和通道规则 |
| 稳定连接 | 关系线绑定对象边界，移动卡片或重新连接后仍保持正确端点 |
| 来源追踪 | 节点和关系记录对应的画布素材、来源与状态 |
| 灵活表达 | 默认使用原生对象；复杂多端口、泳道或密集线路也可生成精确 SVG 图块 |

## 如何在 Yogurt 中体验

1. 在画布上选中需要整理的材料；如果不选，则使用当前页面作为上下文。
2. 打开右上角 `Yogurt AI` 菜单，选择 `生成画布框线图`。
3. 描述你想看清的问题，也可以直接使用 [`native-canvas.prompt.md`](native-canvas.prompt.md) 中的示例指令。
4. 预览生成范围后确认，Yogurt 会把语义分区、卡片和绑定关系直接放到当前画布。
5. 像编辑普通画布内容一样移动、改写、连接或继续让 AI 扩展这张图。

## 两种输出方式

### 原生画布对象

这是默认方式，适合流程、架构、状态图、概念关系、对比和观点—证据结构。每个节点和关系都保持可编辑，并能延续来源映射。本案例的机器可读结构见 [`native-semantic-spec.json`](native-semantic-spec.json)。

### 精确 SVG 图块

当图形依赖精确端口、细粒度泳道或密集避障时，可以使用 [`precision-svg/`](precision-svg/) 中的安全 HTML + inline SVG 方式。它仍然作为一个图块存在于 Yogurt 画布上，适合展示更复杂的几何关系。

校验示例中的精确 SVG：

```powershell
node skills/cowart-semantic-diagram/scripts/validate-semantic-svg.mjs --root examples/semantic-diagram/ai-interactive-film-system/precision-svg examples/semantic-diagram/ai-interactive-film-system/precision-svg/ai-interactive-film-system.html
```

## 案例产物

| 路径 | 内容 |
| --- | --- |
| [`yogurt-semantic-diagram-on-canvas.png`](yogurt-semantic-diagram-on-canvas.png) | 原生框线图在 Yogurt 画布中的实际效果 |
| [`native-canvas.prompt.md`](native-canvas.prompt.md) | 可直接复用的生成指令 |
| [`native-semantic-spec.json`](native-semantic-spec.json) | 节点、关系、布局和来源映射的机器可读规格 |
| [`precision-svg/`](precision-svg/) | 同一主题的精确 SVG 示例、生成指令和预览图 |

如果还需要把产品想法进一步整理成 PRD、交互原型和评审工作区，可以继续体验 [Product Bridge｜分岔回声](../../product-bridge/ai-interactive-film-case/)。
