#!/usr/bin/env python3
"""Initialize a self-contained Yogurt Product Bridge workspace."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def write_new(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite {path}")
    path.write_text(content.strip() + "\n", encoding="utf-8")


def write_json_new(path: Path, value: object) -> None:
    write_new(path, json.dumps(value, ensure_ascii=False, indent=2))


def prototype(name: str) -> str:
    return f"""
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{name} · 首页</title>
<style>
  *{{box-sizing:border-box}} body{{margin:0;font:16px/1.5 Inter,"PingFang SC",sans-serif;color:#1d1d1f;background:#fff}}
  header{{height:72px;border-bottom:1px solid #e8e8e8;display:flex;align-items:center;justify-content:space-between;padding:0 56px}}
  .brand{{display:flex;gap:10px;align-items:center;font-size:20px}} .dot{{width:10px;height:10px;border-radius:50%;background:#ff6234}}
  nav{{background:#f1f1f1;padding:10px 18px;border-radius:999px}} nav span{{margin:0 14px}} nav .on{{color:#ff6234}}
  main{{max-width:1120px;margin:0 auto;padding:72px 32px}} .eyebrow{{color:#777;letter-spacing:.14em;text-transform:uppercase}}
  h1{{font-size:56px;line-height:1.05;margin:16px 0 20px}} .lead{{font-size:20px;color:#555;max-width:720px}}
  .grid{{display:grid;grid-template-columns:1.2fr .8fr;gap:24px;margin-top:48px}} .card{{padding:28px;border:1px solid #ddd;background:#fafafa}}
  button{{border:0;background:#1d1d1f;color:white;padding:14px 22px;font:inherit;cursor:pointer}} button.secondary{{background:white;color:#1d1d1f;border:1px solid #1d1d1f}}
  #state{{margin-top:18px;color:#ff6234;min-height:24px}} ul{{padding-left:20px}}
</style>
<header><div class="brand"><i class="dot"></i>{name}</div><nav><span class="on">首页</span><span>工作台</span><span>设置</span></nav><small>SHAPING</small></header>
<main>
  <div class="eyebrow">Yogurt Product Bridge</div><h1>让思考、需求与原型<br>保持可追溯</h1>
  <p class="lead">这是可交互的起始页面。请按实际产品需求替换内容，并保留可评审的状态、反馈、来源与边界。</p>
  <div class="grid">
    <section class="card"><h2>开始一个评审动作</h2><p>按钮演示成功反馈与二次操作。</p><button id="primary" data-requirement="F-foundation-01" data-annotation-anchor="home.create-review">创建评审</button> <button class="secondary" id="reset">重置</button><div id="state" role="status"></div></section>
    <section class="card"><h2>当前范围</h2><ul><li>Yogurt 来源可追溯</li><li>需求与原型一致</li><li>回流需要预览确认</li></ul></section>
  </div>
</main>
<script>
  const state=document.querySelector('#state');
  document.querySelector('#primary').onclick=()=>state.textContent='已创建评审草稿（模拟）';
  document.querySelector('#reset').onclick=()=>state.textContent='';
</script>
</html>
"""


def components(name: str) -> str:
    return f"""
<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{name} · 组件状态</title>
<style>*{{box-sizing:border-box}}body{{margin:0;padding:64px;font:16px/1.5 Inter,"PingFang SC",sans-serif;color:#1d1d1f}}.eyebrow{{color:#777;letter-spacing:.14em}}h1{{font-size:52px;margin:8px 0 16px}}section{{padding:36px 0;border-bottom:1px solid #ddd}}button{{padding:13px 22px;border:1px solid #222;background:white;font:inherit;margin:8px}}button.primary{{background:#1d1d1f;color:#fff}}button:disabled{{color:#aaa;border-color:#ddd;background:#f5f5f5}}.pill{{display:inline-block;border-radius:99px;background:#fff1ec;color:#ff6234;padding:8px 14px}}input{{padding:13px;border:1px solid #bbb;font:inherit;width:280px}}input:invalid{{border-color:#c6452d}}</style>
<div class="eyebrow">FOUNDATION</div><h1>关键组件与状态</h1><p>先确认共用基线，再扩展详细功能模块。</p>
<section><h2>按钮</h2><button class="primary" data-annotation-anchor="components.primary-action">主要操作</button><button>次要操作</button><button disabled>不可用</button></section>
<section><h2>反馈与输入</h2><span class="pill">● 处理中</span> <input placeholder="输入名称" required></section>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize a Yogurt Product Bridge workspace")
    parser.add_argument("project_dir", help="Target project directory")
    parser.add_argument("--name", default="Untitled Product", help="Product name")
    parser.add_argument("--workspace-id", help="Stable workspace ID; defaults to the target directory name")
    parser.add_argument("--canvas-id", help="Source Yogurt canvas ID")
    parser.add_argument("--page-id", help="Source Yogurt page ID")
    parser.add_argument("--source-revision", help="Captured Yogurt revision")
    parser.add_argument("--scope", choices=("selection", "page"), default="page")
    parser.add_argument("--selection-shape-id", action="append", default=[], help="Captured shape ID; repeat as needed")
    args = parser.parse_args()
    root = Path(args.project_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "interaction-prd.json"
    if manifest.exists():
        print(f"Existing workspace preserved: {manifest}")
        return 2

    workspace_id = args.workspace_id or root.name
    docs = {
        "shaping/01-brief.md": f"""# {args.name} · Brief

## Problem

Describe the user problem and cite relevant `sourceId` values from `bridge/source-packet.json`.

## Audience and desired outcome

- Primary user:
- Desired outcome:
- Success signal:

## Constraints and non-goals

- Constraint:
- Out of scope:

## Assumptions

- [Assumption] Replace or confirm.

## Open questions

- [Open] What decision would materially change scope?
""",
        "shaping/02-requirements.md": """# Requirements inventory

## Actors and permissions

| Actor | Goal | Permission boundary |
|---|---|---|
| Reviewer | Review aligned PRD and prototype | Cannot silently approve inferred scope |

## Rules, data, and exceptions

- Rule:
- Input / output:
- Failure or exception:
""",
        "shaping/03-flows.md": """# Flows and states

## Primary flow

1. Capture a Yogurt page or selection with its revision.
2. Review the generated PRD and prototype against source and requirement IDs.
3. Record annotations and decisions.
4. Preview a small return operation against the current Yogurt revision.
5. Apply only after explicit confirmation.

## Alternative and failure paths

- Empty:
- Loading:
- Validation error:
- Service error:
- Unauthorized source:
- Stale canvas revision:
""",
        "shaping/04-module-plan.md": """# Module plan

| Module | Pages | Yogurt zone | Dependency | Status |
|---|---|---|---|---|
| Foundation | Component states, Home | `zone-foundation` | None | Draft |

## Review decisions

- [Pending] Confirm the first functional module after foundation.
""",
        "DESIGN.md": """# Design baseline

## Tokens

- Ink: `#1d1d1f`
- Accent: `#ff6234`
- Surface: `#fafafa`
- Border: `#dddddd`
- Type: Inter / PingFang SC / system sans-serif

## Layout

- Desktop review viewport: 1280 × 800
- Primary content max width: 1120px
- Prefer surface color and borders over decorative shadows.

## Shared states

Default, hover, focus, disabled, loading, empty, validation error, service error, success, unauthorized.
""",
        "prd/foundation.md": """# Foundation

> Module ID: `foundation` · Status: draft · Viewport: desktop 1280 × 800

## Goal

Establish the reusable interaction, visual, traceability, and synchronization baseline before feature modules multiply.

### F-foundation-01 Create a review draft

- Actor / precondition: Reviewer has opened the home page.
- Trigger: The reviewer selects “创建评审”.
- Requirement: When the reviewer selects the primary action, the product shall show an immediate success result for the simulated draft.
- Rules: One primary action per section; resetting removes the transient result.
- Visible states: default, success.
- Source evidence: pending capture in `bridge/source-packet.json`.
- Acceptance:
  - Given the default home page, when the reviewer selects “创建评审”, then “已创建评审草稿（模拟）” is visible.
  - Given a visible result, when the reviewer selects “重置”, then the result is cleared.
- Prototype coverage: `home`, annotation 1.

### NFR-foundation-01 Portable review

The review workspace shall run locally without hosted runtime dependencies.
""",
    }
    for relative, content in docs.items():
        write_new(root / relative, content)
    write_new(root / "prototypes/home.html", prototype(args.name))
    write_new(root / "prototypes/components.html", components(args.name))

    source_packet = {
        "version": 1,
        "workspaceId": workspace_id,
        "productName": args.name,
        "capture": {
            "canvasId": args.canvas_id,
            "pageId": args.page_id,
            "scope": args.scope,
            "sourceRevision": args.source_revision,
            "selectionShapeIds": args.selection_shape_id,
        },
        "sources": [],
        "ideas": [],
        "assumptions": [],
        "openQuestions": [],
    }
    trace_map = {"version": 1, "workspaceId": workspace_id, "mappings": []}
    sync_state = {
        "version": 1,
        "workspaceId": workspace_id,
        "returnFlow": {
            "mode": "dry-run-required",
            "status": "idle",
            "sourceRevision": args.source_revision,
            "previewBaseRevision": None,
            "operationDigest": None,
            "confirmation": {"required": True, "confirmed": False, "confirmedAt": None},
            "appliedRevision": None,
            "operationId": None,
            "pendingMappingUpdates": [],
            "conflicts": [],
        },
    }
    write_json_new(root / "bridge/source-packet.json", source_packet)
    write_json_new(root / "bridge/trace-map.json", trace_map)
    write_json_new(root / "bridge/sync-state.json", sync_state)

    project = {
        "version": 1,
        "product": {"name": args.name, "stage": "SHAPING", "viewport": {"width": 1280, "height": 800}},
        "settings": {"showShaping": True},
        "bridge": {
            "sourcePacketPath": "bridge/source-packet.json",
            "traceMapPath": "bridge/trace-map.json",
            "syncStatePath": "bridge/sync-state.json",
        },
        "documents": [
            {"id": "brief", "title": "01 · Brief", "kind": "shaping", "path": "shaping/01-brief.md"},
            {"id": "requirements", "title": "02 · Requirements", "kind": "shaping", "path": "shaping/02-requirements.md"},
            {"id": "flows", "title": "03 · Flows", "kind": "shaping", "path": "shaping/03-flows.md"},
            {"id": "module-plan", "title": "04 · Module plan", "kind": "shaping", "path": "shaping/04-module-plan.md"},
            {"id": "design", "title": "DESIGN", "kind": "design", "path": "DESIGN.md"},
        ],
        "modules": [{
            "id": "foundation", "title": "Foundation", "status": "draft",
            "summary": "Shared components, states, traceability, and review baseline", "prdPath": "prd/foundation.md",
            "pages": [
                {"id": "components", "title": "组件与状态", "prototypePath": "prototypes/components.html", "viewport": {"width": 1280, "height": 800}, "position": {"x": 80, "y": 80}, "annotations": [], "transitions": [{"to": "home", "label": "开始评审", "type": "flow", "direction": "forward", "path": "primary", "payload": "评审草稿"}]},
                {"id": "home", "title": "首页", "prototypePath": "prototypes/home.html", "viewport": {"width": 1280, "height": 800}, "position": {"x": 520, "y": 80}, "annotations": [{"id": 1, "x": 37, "y": 64, "anchor": {"type": "element", "key": "home.create-review", "point": {"x": 1, "y": 0.5}, "offset": {"x": 8, "y": 0}}, "title": "创建评审", "body": "点击后显示模拟成功反馈；可重置。", "requirementId": "F-foundation-01"}], "transitions": []},
            ],
        }],
    }
    write_json_new(manifest, project)
    print(f"Created Yogurt Product Bridge workspace: {root}")
    print(f"Manifest: {manifest}")
    print(f"Source packet: {root / 'bridge/source-packet.json'}")
    print("Next: capture Yogurt sources, author product artifacts, then run validate_workspace.py --strict.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
