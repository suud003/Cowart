#!/usr/bin/env python3
"""Validate bridge contracts, annotation anchors, and core workspace paths."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

ACCESS_STATUSES = {"available", "unread", "not-configured", "denied", "error"}
SOURCE_KINDS = {"yogurt-shape", "user-note", "tapd-link", "document", "image", "code", "other"}
SYNC_STATUSES = {"idle", "previewed", "awaiting-confirmation", "confirmed", "applied", "stale", "conflict", "undone"}
TRANSITION_TYPES = {"flow", "dispatch", "claim", "sync", "association", "compare"}
TRANSITION_DIRECTIONS = {"forward", "bidirectional", "none"}
TRANSITION_PATHS = {"primary", "alternative"}
BRIDGE_PATHS = {
    "sourcePacketPath": "bridge/source-packet.json",
    "traceMapPath": "bridge/trace-map.json",
    "syncStatePath": "bridge/sync-state.json",
}
REQUIREMENT_HEADING = re.compile(r"^###\s+((?:F|NFR)-[A-Za-z0-9][A-Za-z0-9-]*-\d+)\b", re.MULTILINE)


class AnchorParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: Counter[str] = Counter()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del tag
        attributes = dict(attrs)
        key = attributes.get("data-annotation-anchor")
        if key:
            self.anchors[key] += 1

    handle_startendtag = handle_starttag


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def object_value(value: Any, label: str, errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{label}: must be an object")
        return None
    return value


def list_value(value: Any, label: str, errors: list[str]) -> list[Any] | None:
    if not isinstance(value, list):
        errors.append(f"{label}: must be a list")
        return None
    return value


def string_list(value: Any, label: str, errors: list[str]) -> list[str]:
    items = list_value(value, label, errors)
    if items is None:
        return []
    valid: list[str] = []
    for index, item in enumerate(items):
        if not isinstance(item, str) or not item:
            errors.append(f"{label}[{index}]: must be a non-empty string")
        else:
            valid.append(item)
    return valid


def validate_unit_point(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label}: point must be an object")
        return
    for axis in ("x", "y"):
        coordinate = value.get(axis)
        if not is_finite_number(coordinate) or not 0 <= coordinate <= 1:
            errors.append(f"{label}: point.{axis} must be a number from 0 to 1")


def validate_page_geometry(page: dict[str, Any], label: str, errors: list[str]) -> None:
    position = object_value(page.get("position"), f"{label} position", errors)
    if position is not None:
        for axis in ("x", "y"):
            if not is_finite_number(position.get(axis)):
                errors.append(f"{label}: position.{axis} must be a finite number")

    viewport = object_value(page.get("viewport"), f"{label} viewport", errors)
    if viewport is not None:
        for dimension in ("width", "height"):
            value = viewport.get(dimension)
            if not is_finite_number(value) or value <= 0:
                errors.append(f"{label}: viewport.{dimension} must be a positive finite number")


def inside(project_dir: Path, raw: Any, label: str, errors: list[str]) -> Path | None:
    if not isinstance(raw, str) or not raw:
        errors.append(f"{label}: path must be a non-empty string")
        return None
    path = (project_dir / raw).resolve()
    try:
        path.relative_to(project_dir.resolve())
    except ValueError:
        errors.append(f"{label}: path escapes the workspace")
        return None
    return path


def load_json(path: Path | None, label: str, errors: list[str]) -> dict[str, Any] | None:
    if path is None:
        return None
    if not path.is_file():
        errors.append(f"{label}: missing file {path}")
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{label}: cannot read JSON: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{label}: root must be an object")
        return None
    return value


def validate_source_packet(packet: dict[str, Any] | None, errors: list[str]) -> tuple[set[str], str | None]:
    source_ids: set[str] = set()
    if packet is None:
        return source_ids, None
    if packet.get("version") != 1:
        errors.append("source packet: version must be 1")
    workspace_id = packet.get("workspaceId")
    if not isinstance(workspace_id, str) or not workspace_id:
        errors.append("source packet: workspaceId must be a non-empty string")
        workspace_id = None
    capture = object_value(packet.get("capture"), "source packet: capture", errors)
    if capture is not None:
        if capture.get("scope") not in {"selection", "page"}:
            errors.append("source packet: capture.scope must be 'selection' or 'page'")
        string_list(capture.get("selectionShapeIds"), "source packet: capture.selectionShapeIds", errors)

    for key in ("ideas", "assumptions", "openQuestions"):
        entries = list_value(packet.get(key), f"source packet: {key}", errors)
        if entries is not None:
            for index, entry in enumerate(entries):
                object_value(entry, f"source packet: {key}[{index}]", errors)

    sources = list_value(packet.get("sources"), "source packet: sources", errors)
    if sources is None:
        return source_ids, workspace_id
    for index, source in enumerate(sources):
        label = f"source packet source {index + 1}"
        if not isinstance(source, dict):
            errors.append(f"{label}: must be an object")
            continue
        source_id = source.get("id")
        if not isinstance(source_id, str) or not source_id:
            errors.append(f"{label}: id must be a non-empty string")
        elif source_id in source_ids:
            errors.append(f"{label}: duplicate id '{source_id}'")
        else:
            source_ids.add(source_id)
        kind = source.get("kind")
        if kind not in SOURCE_KINDS:
            errors.append(f"{label}: unsupported kind '{kind}'")
        status = source.get("accessStatus")
        if status not in ACCESS_STATUSES:
            errors.append(f"{label}: unsupported accessStatus '{status}'")
        string_list(source.get("yogurtShapeIds"), f"{label}: yogurtShapeIds", errors)
        provenance = object_value(source.get("provenance"), f"{label}: provenance", errors)
        if kind == "tapd-link":
            uri = provenance.get("uri") if provenance is not None else None
            if not isinstance(uri, str) or not uri:
                errors.append(f"{label}: TAPD reference requires provenance.uri")
            has_content = bool(source.get("summary") or source.get("excerpt"))
            if status == "available" and not has_content:
                errors.append(f"{label}: available TAPD content requires a summary or excerpt")
            if status in {"unread", "not-configured", "denied", "error"} and has_content:
                errors.append(f"{label}: inaccessible TAPD reference must not claim linked summary or excerpt content")
    return source_ids, workspace_id


def validate_trace_map(
    trace_map: dict[str, Any] | None,
    workspace_id: str | None,
    source_ids: set[str],
    page_ids: set[str],
    annotation_refs: set[str],
    requirement_ids: set[str],
    errors: list[str],
) -> None:
    if trace_map is None:
        return
    if trace_map.get("version") != 1:
        errors.append("trace map: version must be 1")
    if workspace_id and trace_map.get("workspaceId") != workspace_id:
        errors.append("trace map: workspaceId must match source packet")
    mappings = list_value(trace_map.get("mappings"), "trace map: mappings", errors)
    if mappings is None:
        return
    mapping_ids: set[str] = set()
    for index, mapping in enumerate(mappings):
        label = f"trace map mapping {index + 1}"
        if not isinstance(mapping, dict):
            errors.append(f"{label}: must be an object")
            continue
        mapping_id = mapping.get("id")
        if not isinstance(mapping_id, str) or not mapping_id:
            errors.append(f"{label}: id must be a non-empty string")
        elif mapping_id in mapping_ids:
            errors.append(f"{label}: duplicate id '{mapping_id}'")
        else:
            mapping_ids.add(mapping_id)
        if not isinstance(mapping.get("zoneId"), str) or not mapping.get("zoneId"):
            errors.append(f"{label}: zoneId must be a non-empty string")
        mapped_source_ids = string_list(mapping.get("sourceIds"), f"{label}: sourceIds", errors)
        string_list(mapping.get("yogurtShapeIds"), f"{label}: yogurtShapeIds", errors)
        mapped_requirement_ids = string_list(mapping.get("requirementIds"), f"{label}: requirementIds", errors)
        mapped_page_ids = string_list(mapping.get("pageIds"), f"{label}: pageIds", errors)
        mapped_annotation_refs = string_list(mapping.get("annotationRefs"), f"{label}: annotationRefs", errors)
        string_list(mapping.get("returnedShapeIds"), f"{label}: returnedShapeIds", errors)
        for source_id in mapped_source_ids:
            if source_id not in source_ids:
                errors.append(f"{label}: unknown sourceId '{source_id}'")
        for requirement_id in mapped_requirement_ids:
            if requirement_id not in requirement_ids:
                errors.append(f"{label}: unknown requirementId '{requirement_id}'")
        for page_id in mapped_page_ids:
            if page_id not in page_ids:
                errors.append(f"{label}: unknown pageId '{page_id}'")
        for annotation_ref in mapped_annotation_refs:
            if annotation_ref not in annotation_refs:
                errors.append(f"{label}: unknown annotationRef '{annotation_ref}'")


def validate_sync_state(sync_state: dict[str, Any] | None, workspace_id: str | None, errors: list[str]) -> None:
    if sync_state is None:
        return
    if sync_state.get("version") != 1:
        errors.append("sync state: version must be 1")
    if workspace_id and sync_state.get("workspaceId") != workspace_id:
        errors.append("sync state: workspaceId must match source packet")
    flow = sync_state.get("returnFlow")
    if not isinstance(flow, dict):
        errors.append("sync state: returnFlow must be an object")
        return
    if flow.get("mode") != "dry-run-required":
        errors.append("sync state: returnFlow.mode must be 'dry-run-required'")
    status = flow.get("status")
    if status not in SYNC_STATUSES:
        errors.append(f"sync state: unsupported returnFlow.status '{status}'")
    confirmation = flow.get("confirmation")
    if not isinstance(confirmation, dict) or confirmation.get("required") is not True:
        errors.append("sync state: explicit confirmation must be required")
        confirmation = {}
    list_value(flow.get("pendingMappingUpdates"), "sync state: returnFlow.pendingMappingUpdates", errors)
    list_value(flow.get("conflicts"), "sync state: returnFlow.conflicts", errors)
    if status in {"previewed", "awaiting-confirmation", "confirmed", "applied"}:
        if flow.get("previewBaseRevision") is None:
            errors.append(f"sync state: {status} return requires previewBaseRevision")
        if not isinstance(flow.get("operationDigest"), str) or not flow.get("operationDigest"):
            errors.append(f"sync state: {status} return requires operationDigest")
    if status in {"confirmed", "applied"} and confirmation.get("confirmed") is not True:
        errors.append(f"sync state: {status} return requires explicit confirmation")
    if status == "applied":
        if flow.get("appliedRevision") is None:
            errors.append("sync state: applied return requires appliedRevision")
        if not isinstance(flow.get("operationId"), str) or not flow.get("operationId"):
            errors.append("sync state: applied return requires operationId")


def validate_workspace(project_dir: Path) -> tuple[list[str], list[str], int, int]:
    errors: list[str] = []
    warnings: list[str] = []
    pages_checked = 0
    annotations_checked = 0
    manifest_path = project_dir / "interaction-prd.json"

    if not manifest_path.is_file():
        return [f"Missing manifest: {manifest_path}"], warnings, 0, 0
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"Cannot read manifest: {exc}"], warnings, 0, 0
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        return ["Manifest must be a version 1 object"], warnings, 0, 0

    object_value(manifest.get("product"), "Manifest product", errors)
    object_value(manifest.get("settings"), "Manifest settings", errors)

    requirement_ids: set[str] = set()
    requirement_origins: dict[str, str] = {}
    registered_prd_paths: set[Path] = set()

    def collect_requirements(prd_path: Path, prd_path_raw: Any, label: str) -> None:
        resolved_path = prd_path.resolve()
        if resolved_path in registered_prd_paths:
            return
        registered_prd_paths.add(resolved_path)
        try:
            prd_text = prd_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            errors.append(f"{label}: cannot read PRD: {exc}")
            return
        for requirement_id in REQUIREMENT_HEADING.findall(prd_text):
            if requirement_id in requirement_ids:
                errors.append(
                    f"{label}: duplicate requirementId '{requirement_id}' "
                    f"also defined in {requirement_origins[requirement_id]}"
                )
            else:
                requirement_ids.add(requirement_id)
                requirement_origins[requirement_id] = str(prd_path_raw)

    documents = list_value(manifest.get("documents"), "Manifest documents", errors) or []
    for index, document_value in enumerate(documents):
        label = f"Manifest document {index + 1}"
        document = object_value(document_value, label, errors)
        if document is None:
            continue
        document_path = inside(project_dir, document.get("path"), f"{label} path", errors)
        if document_path is not None:
            if not document_path.is_file():
                errors.append(f"{label}: missing file {document.get('path')}")
            elif document.get("kind") == "prd":
                collect_requirements(document_path, document.get("path"), label)

    modules = list_value(manifest.get("modules"), "Manifest modules", errors) or []
    page_ids: set[str] = set()
    page_records: list[tuple[str, dict[str, Any]]] = []

    # First pass: resolve every module PRD and collect all page/requirement IDs.
    # Standalone PRD documents register requirements too, without inventing a prototype page.
    for module_index, module_value in enumerate(modules):
        module_label = f"Manifest module {module_index + 1}"
        module = object_value(module_value, module_label, errors)
        if module is None:
            continue
        module_id_value = module.get("id")
        if not isinstance(module_id_value, str) or not module_id_value:
            errors.append(f"{module_label}: id must be a non-empty string")
            module_id = f"<module-{module_index + 1}>"
        else:
            module_id = module_id_value

        prd_path_raw = module.get("prdPath")
        prd_path = inside(project_dir, prd_path_raw, f"{module_label} prdPath", errors)
        if prd_path is not None:
            if not prd_path.is_file():
                errors.append(f"{module_label}: missing PRD {prd_path_raw}")
            else:
                collect_requirements(prd_path, prd_path_raw, module_label)

        pages = list_value(module.get("pages"), f"{module_label} pages", errors) or []
        for page_index, page_value in enumerate(pages):
            page_label = f"{module_label} page {page_index + 1}"
            page = object_value(page_value, page_label, errors)
            if page is None:
                continue
            page_id_value = page.get("id")
            if not isinstance(page_id_value, str) or not page_id_value:
                errors.append(f"{page_label}: id must be a non-empty string")
                page_id = f"<page-{module_index + 1}-{page_index + 1}>"
            else:
                page_id = page_id_value
                if page_id in page_ids:
                    errors.append(f"{module_id}/{page_id}: duplicate page id '{page_id}'")
                page_ids.add(page_id)
            page_records.append((module_id, page))

    annotation_refs: set[str] = set()
    # Second pass: all page IDs and PRD requirement IDs are now available for references.
    for module_id, page in page_records:
        pages_checked += 1
        page_id_value = page.get("id")
        page_id = page_id_value if isinstance(page_id_value, str) and page_id_value else "<page>"
        label = f"{module_id}/{page_id}"
        validate_page_geometry(page, label, errors)
        prototype_path = page.get("prototypePath")
        prototype = inside(project_dir, prototype_path, f"{label} prototypePath", errors)
        anchor_parser = AnchorParser()
        prototype_readable = False
        if prototype is not None:
            if not prototype.is_file():
                errors.append(f"{label}: missing prototype {prototype_path}")
            else:
                try:
                    anchor_parser.feed(prototype.read_text(encoding="utf-8"))
                    prototype_readable = True
                except (OSError, UnicodeDecodeError) as exc:
                    errors.append(f"{label}: cannot read prototype: {exc}")
        if prototype_readable:
            for key, count in sorted(anchor_parser.anchors.items()):
                if count > 1:
                    errors.append(f"{label}: data-annotation-anchor '{key}' appears {count} times")

        transitions = list_value(page.get("transitions"), f"{label} transitions", errors) or []
        for transition_index, transition_value in enumerate(transitions):
            transition_label = f"{label} transition {transition_index + 1}"
            transition = object_value(transition_value, transition_label, errors)
            if transition is None:
                continue
            target = transition.get("to")
            if not isinstance(target, str) or not target:
                errors.append(f"{transition_label}: to must be a non-empty page ID")
            elif target not in page_ids:
                errors.append(f"{transition_label}: unknown target page '{target}'")
            transition_type = transition.get("type")
            if transition_type is not None and (
                not isinstance(transition_type, str) or transition_type not in TRANSITION_TYPES
            ):
                errors.append(
                    f"{transition_label}: type must be one of {sorted(TRANSITION_TYPES)}"
                )
            direction = transition.get("direction")
            if direction is not None and (
                not isinstance(direction, str) or direction not in TRANSITION_DIRECTIONS
            ):
                errors.append(
                    f"{transition_label}: direction must be one of {sorted(TRANSITION_DIRECTIONS)}"
                )
            path_kind = transition.get("path")
            if path_kind is not None and (
                not isinstance(path_kind, str) or path_kind not in TRANSITION_PATHS
            ):
                errors.append(
                    f"{transition_label}: path must be one of {sorted(TRANSITION_PATHS)}"
                )
            for text_field in ("label", "payload"):
                text_value = transition.get(text_field)
                if text_value is not None and not isinstance(text_value, str):
                    errors.append(f"{transition_label}: {text_field} must be a string")

        annotations = list_value(page.get("annotations"), f"{label} annotations", errors) or []
        annotation_ids: Counter[str] = Counter()
        for annotation_index, annotation_value in enumerate(annotations):
            annotations_checked += 1
            annotation = object_value(annotation_value, f"{label} annotation {annotation_index + 1}", errors)
            if annotation is None:
                continue
            raw_annotation_id = annotation.get("id")
            if not isinstance(raw_annotation_id, (str, int)) or isinstance(raw_annotation_id, bool) or str(raw_annotation_id) == "":
                errors.append(f"{label} annotation {annotation_index + 1}: id must be a non-empty string or integer")
                annotation_id = f"<annotation-{annotation_index + 1}>"
            else:
                annotation_id = str(raw_annotation_id)
                annotation_ids[annotation_id] += 1
                if page_id != "<page>":
                    annotation_refs.add(f"{page_id}#{annotation_id}")
            annotation_label = f"{label} annotation {annotation_id}"

            requirement_id = annotation.get("requirementId")
            if requirement_id is not None and not isinstance(requirement_id, str):
                errors.append(f"{annotation_label}: requirementId must be a string when provided")
            elif isinstance(requirement_id, str) and requirement_id.strip() and requirement_id not in requirement_ids:
                errors.append(f"{annotation_label}: unknown requirementId '{requirement_id}'")

            for axis in ("x", "y"):
                coordinate = annotation.get(axis)
                if not is_finite_number(coordinate) or not 0 <= coordinate <= 100:
                    errors.append(f"{annotation_label}: fallback {axis} must be a number from 0 to 100")

            anchor = annotation.get("anchor")
            if not isinstance(anchor, dict):
                target = annotation.get("target")
                if target is not None and not isinstance(target, dict):
                    errors.append(f"{annotation_label}: target must be an object")
                elif isinstance(target, dict):
                    warnings.append(f"{annotation_label}: selector target is fragile; add an element anchor key")
                else:
                    warnings.append(f"{annotation_label}: coordinate-only annotation; add an element anchor key")
                continue
            if anchor.get("type") != "element":
                errors.append(f"{annotation_label}: anchor.type must be 'element'")
            key = anchor.get("key")
            if not isinstance(key, str) or not key:
                errors.append(f"{annotation_label}: anchor.key must be a non-empty string")
            elif prototype_readable:
                count = anchor_parser.anchors.get(key, 0)
                if count == 0:
                    errors.append(f"{annotation_label}: anchor '{key}' is missing from {prototype_path}")
                elif count > 1:
                    errors.append(f"{annotation_label}: anchor '{key}' is not unique in {prototype_path}")
            validate_unit_point(anchor.get("point", {"x": 0.5, "y": 0.5}), annotation_label, errors)
            offset = anchor.get("offset", {"x": 0, "y": 0})
            if not isinstance(offset, dict) or any(not is_finite_number(offset.get(axis, 0)) for axis in ("x", "y")):
                errors.append(f"{annotation_label}: anchor.offset must contain finite x/y values")
        for annotation_id, count in annotation_ids.items():
            if count > 1:
                errors.append(f"{label}: annotation id '{annotation_id}' appears {count} times")

    bridge = manifest.get("bridge")
    if not isinstance(bridge, dict):
        errors.append("Manifest bridge must be an object")
        bridge = {}
    paths: dict[str, Path | None] = {}
    for key, expected in BRIDGE_PATHS.items():
        raw = bridge.get(key)
        if raw != expected:
            errors.append(f"Manifest bridge.{key} must be '{expected}'")
        paths[key] = inside(project_dir, raw, f"bridge.{key}", errors)

    packet = load_json(paths.get("sourcePacketPath"), "source packet", errors)
    source_ids, workspace_id = validate_source_packet(packet, errors)
    trace_map = load_json(paths.get("traceMapPath"), "trace map", errors)
    validate_trace_map(trace_map, workspace_id, source_ids, page_ids, annotation_refs, requirement_ids, errors)
    sync_state = load_json(paths.get("syncStatePath"), "sync state", errors)
    validate_sync_state(sync_state, workspace_id, errors)
    return errors, warnings, pages_checked, annotations_checked


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path, help="Workspace containing interaction-prd.json")
    parser.add_argument("--strict", action="store_true", help="Treat compatibility warnings as a failed validation")
    args = parser.parse_args()

    project_dir = args.project_dir.expanduser().resolve()
    errors, warnings, pages, annotations = validate_workspace(project_dir)
    for message in warnings:
        print(f"WARNING: {message}")
    for message in errors:
        print(f"ERROR: {message}")
    print(f"Checked bridge contracts, {pages} page(s), and {annotations} annotation(s): {len(errors)} error(s), {len(warnings)} warning(s)")
    if errors:
        return 1
    if args.strict and warnings:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
