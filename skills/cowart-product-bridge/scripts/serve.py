#!/usr/bin/env python3
"""Serve the product review container and persist reviewer edits."""

from __future__ import annotations

import argparse
import json
import os
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MAX_BODY = 10 * 1024 * 1024
EDITABLE_SUFFIXES = {".md", ".json", ".html", ".css", ".js", ".txt"}
STATIC_CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


def inside(root: Path, raw: str) -> Path:
    candidate = (root / raw).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Path escapes the project root") from exc
    return candidate


class ReviewHandler(SimpleHTTPRequestHandler):
    project_root: Path
    viewer_root: Path

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.viewer_root), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[cowart-product-bridge] {self.address_string()} {fmt % args}")

    def guess_type(self, path: str) -> str:
        """Return deterministic web MIME types instead of OS registry guesses."""
        suffix = Path(urlparse(path).path).suffix.lower()
        return STATIC_CONTENT_TYPES.get(suffix, super().guess_type(path))

    def send_json(self, value, status=HTTPStatus.OK) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_text(self, value: str, content_type="text/plain; charset=utf-8") -> None:
        payload = value.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Invalid request size")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/project":
                data = json.loads((self.project_root / "interaction-prd.json").read_text(encoding="utf-8"))
                self.send_json(data)
                return
            if parsed.path == "/api/file":
                raw = parse_qs(parsed.query).get("path", [""])[0]
                path = inside(self.project_root, raw)
                if not path.is_file():
                    self.send_json({"error": "File not found"}, HTTPStatus.NOT_FOUND)
                    return
                content_type = "text/html; charset=utf-8" if path.suffix.lower() == ".html" else "text/plain; charset=utf-8"
                self.send_text(path.read_text(encoding="utf-8"), content_type)
                return
            if parsed.path == "/api/files":
                files = [str(p.relative_to(self.project_root)).replace("\\", "/") for p in self.project_root.rglob("*") if p.is_file() and p.suffix.lower() in EDITABLE_SUFFIXES]
                self.send_json({"files": sorted(files)})
                return
            super().do_GET()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            body = self.read_json()
            if parsed.path == "/api/project":
                if not isinstance(body, dict) or body.get("version") != 1:
                    raise ValueError("Project must be a version 1 object")
                target = self.project_root / "interaction-prd.json"
                temp = target.with_suffix(".json.tmp")
                temp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                os.replace(temp, target)
                self.send_json({"ok": True})
                return
            if parsed.path == "/api/file":
                raw = body.get("path", "")
                content = body.get("content")
                if not isinstance(content, str):
                    raise ValueError("content must be a string")
                target = inside(self.project_root, raw)
                if target.suffix.lower() not in EDITABLE_SUFFIXES:
                    raise ValueError("File type is not editable")
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_suffix(target.suffix + ".tmp")
                temp.write_text(content, encoding="utf-8")
                os.replace(temp, target)
                self.send_json({"ok": True, "path": raw})
                return
            self.send_json({"error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the Yogurt Product Bridge review container")
    parser.add_argument("project_dir", help="Directory containing interaction-prd.json")
    parser.add_argument("--port", type=int, default=0, help="Port to bind; defaults to a random free local port")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser")
    args = parser.parse_args()
    root = Path(args.project_dir).expanduser().resolve()
    manifest = root / "interaction-prd.json"
    if not manifest.is_file():
        parser.error(f"Missing {manifest}; initialize the workspace first")
    json.loads(manifest.read_text(encoding="utf-8"))
    viewer = Path(__file__).resolve().parents[1] / "assets" / "container"
    if not (viewer / "index.html").is_file():
        parser.error(f"Missing viewer assets at {viewer}")

    ReviewHandler.project_root = root
    ReviewHandler.viewer_root = viewer
    server = ThreadingHTTPServer(("127.0.0.1", args.port), ReviewHandler)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Yogurt Product Bridge: {url}", flush=True)
    print(f"Workspace: {root}", flush=True)
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
