# 复现 Prompt｜AI 互动影游画布原生框线图

请使用当前 Yogurt AI 选区；没有选区时使用当前页面。把材料直接整理成当前画布上的原生框线图，不要启动 Product Bridge，不要创建 PRD 工作区，也不要把任何图注册到 `interaction-prd.json`。

核心判断：AI 互动影游不是自由生成。创作者约束与安全闸门共同控制 AI 导演；玩家行动只有通过可行性与安全检查后，才会在可追踪状态内推动下一幕。

要求：

1. 默认使用 Yogurt 原生语义分区、卡片和绑定关系线，不生成 HTML/SVG。
2. 采用从左到右的阅读顺序，展示创作者约束 → 叙事编译器 → AI 导演 → 状态账本 → 下一幕与可解释结局的主路径。
3. 玩家行动直接触发 AI 导演；安全与成本闸门以虚线“放行或回退”关系连接 AI 导演。
4. 所有节点和关系使用稳定且唯一的 semantic ID；保留 diagram ID、来源 IDs、origin 和 state。
5. 连线必须使用真实 start/end binding 锚定节点边界；标签不要覆盖节点或其他关系，跨层关系选择独立 lane，并在遇到无关节点时从外侧绕行。
6. 如果是修订现有语义关系，在同一批次先删除旧关系再用相同 semantic ID 重建，不要制造重复关系。
7. 先 dry-run，确认基准 revision 未变化后再原子应用，并返回 operation ID 和 result revision。

只有我明确要求“精确 SVG”时，才改走安全 HTML + inline SVG 路线；即使走 SVG 路线，也只插入当前 Yogurt 画布，不进入 PRD 交互工作区。
