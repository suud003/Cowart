#!/usr/bin/env python3
"""Isolated regression tests for bridge workspace validation."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from validate_workspace import validate_workspace  # noqa: E402


class WorkspaceValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cowart-bridge-validator-")
        self.root = Path(self.temporary.name) / "workspace"
        subprocess.run(
            [sys.executable, "-B", str(SCRIPT_DIR / "init_workspace.py"), str(self.root), "--name", "Validator Fixture"],
            check=True,
            capture_output=True,
            text=True,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def manifest(self) -> dict:
        return json.loads((self.root / "interaction-prd.json").read_text(encoding="utf-8"))

    def save_manifest(self, value: dict) -> None:
        (self.root / "interaction-prd.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def errors(self) -> list[str]:
        errors, warnings, _pages, _annotations = validate_workspace(self.root)
        self.assertEqual([], warnings)
        return errors

    def test_initialized_workspace_is_valid(self) -> None:
        self.assertEqual([], self.errors())

    def test_rejects_escaping_document_path(self) -> None:
        manifest = self.manifest()
        manifest["documents"][0]["path"] = "../outside.md"
        self.save_manifest(manifest)
        self.assertTrue(any("path escapes the workspace" in error for error in self.errors()))

    def test_rejects_unknown_transition(self) -> None:
        manifest = self.manifest()
        manifest["modules"][0]["pages"][0]["transitions"] = [{"to": "missing-page", "label": "bad"}]
        self.save_manifest(manifest)
        self.assertTrue(any("unknown target page 'missing-page'" in error for error in self.errors()))

    def test_accepts_semantic_transition_fields(self) -> None:
        manifest = self.manifest()
        manifest["modules"][0]["pages"][0]["transitions"] = [{
            "to": "home",
            "label": "同步",
            "type": "sync",
            "direction": "bidirectional",
            "path": "alternative",
            "payload": "评审状态",
        }]
        self.save_manifest(manifest)
        self.assertEqual([], self.errors())

    def test_rejects_invalid_transition_semantics(self) -> None:
        manifest = self.manifest()
        manifest["modules"][0]["pages"][0]["transitions"] = [{
            "to": "home",
            "type": ["teleport"],
            "direction": "sideways",
            "path": "mystery",
            "payload": ["not", "text"],
        }]
        self.save_manifest(manifest)
        errors = self.errors()
        self.assertTrue(any("type must be one of" in error for error in errors))
        self.assertTrue(any("direction must be one of" in error for error in errors))
        self.assertTrue(any("path must be one of" in error for error in errors))
        self.assertTrue(any("payload must be a string" in error for error in errors))

    def test_rejects_unknown_annotation_requirement(self) -> None:
        manifest = self.manifest()
        manifest["modules"][0]["pages"][1]["annotations"][0]["requirementId"] = "F-missing-99"
        self.save_manifest(manifest)
        self.assertTrue(any("unknown requirementId 'F-missing-99'" in error for error in self.errors()))

    def test_accepts_blank_annotation_requirement_while_triaging(self) -> None:
        manifest = self.manifest()
        manifest["modules"][0]["pages"][1]["annotations"][0]["requirementId"] = ""
        self.save_manifest(manifest)
        self.assertEqual([], self.errors())

    def test_rejects_missing_position_and_invalid_viewport(self) -> None:
        manifest = self.manifest()
        page = manifest["modules"][0]["pages"][0]
        del page["position"]
        page["viewport"]["width"] = 0
        page["viewport"]["height"] = "800"
        self.save_manifest(manifest)
        errors = self.errors()
        self.assertTrue(any("position: must be an object" in error for error in errors))
        self.assertTrue(any("viewport.width must be a positive finite number" in error for error in errors))
        self.assertTrue(any("viewport.height must be a positive finite number" in error for error in errors))

    def test_rejects_unknown_trace_requirement(self) -> None:
        trace_path = self.root / "bridge" / "trace-map.json"
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        trace["mappings"] = [{
            "id": "map-bad", "sourceIds": [], "yogurtShapeIds": [], "zoneId": "zone-bad",
            "requirementIds": ["F-missing-99"], "pageIds": ["home"],
            "annotationRefs": ["home#1"], "returnedShapeIds": [], "lastSyncedRevision": None,
        }]
        trace_path.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.assertTrue(any("unknown requirementId 'F-missing-99'" in error for error in self.errors()))

    def test_rejects_string_instead_of_transition_list(self) -> None:
        manifest = self.manifest()
        manifest["modules"][0]["pages"][0]["transitions"] = "home"
        self.save_manifest(manifest)
        self.assertTrue(any("transitions: must be a list" in error for error in self.errors()))


if __name__ == "__main__":
    unittest.main()
