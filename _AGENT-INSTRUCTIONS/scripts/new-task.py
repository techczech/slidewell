#!/usr/bin/env python3
"""Create a project task record with local audit metadata."""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
from datetime import datetime, timezone
from pathlib import Path


STATUS_VALUES = {
    "proposed",
    "active",
    "needs-clarification",
    "blocked",
    "waiting",
    "review",
    "done",
    "superseded",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "task"


def codex_thread_uri() -> str:
    thread_id = os.environ.get("CODEX_THREAD_ID", "").strip()
    if not thread_id:
        return ""
    return f"codex://threads/{thread_id}"


def detect_agent() -> str:
    origin = os.environ.get("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "")
    if os.environ.get("CODEX_SHELL") or "Codex" in origin:
        return "codex-desktop"
    return os.environ.get("USER", "agent")


def yaml_list_field(name: str, items: list[str], indent: int = 2) -> str:
    if not items:
        return f"{name}: []"
    pad = " " * indent
    values = "\n".join(f"{pad}- {item}" for item in items)
    return f"{name}:\n{values}"


def task_body(task_id: str, title: str, status: str, now: str, root: Path, source_inputs: list[str]) -> str:
    return f"""---
entity_type: task
id: {task_id}
title: "{title}"
status: {status}
created_at: {now}
updated_at: {now}
requested_by: dominik
request_source: chat
audit:
  agent: {detect_agent()}
  thread_uri: {codex_thread_uri()}
  machine: {socket.gethostname()}
  cwd: {root}
scope: []
{yaml_list_field("source_inputs", source_inputs)}
content_refs: []
source_refs: []
blocked_by: []
waiting_on:
next_action:
---

# {title}

## Request

{title}

## Status

Created task record.

## Open Questions

-

## Links

-

## Log

- {now} - Created task.
"""


def append_action(task_log: Path, task_id: str, status: str, now: str, summary: str) -> None:
    entry = {
        "timestamp": now,
        "task_id": task_id,
        "action": "created",
        "status": status,
        "summary": summary,
    }
    with (task_log / "actions.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a Markdown task in _TASK-LOG/.")
    parser.add_argument("title", help="Human-readable task title.")
    parser.add_argument("--slug", help="Stable filename slug. Defaults to the title.")
    parser.add_argument("--status", default="active", choices=sorted(STATUS_VALUES))
    parser.add_argument("--source-input", action="append", default=[], help="Relative source-input path. Repeat as needed.")
    parser.add_argument("--root", default=".", help="Project root. Defaults to the current directory.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    task_log = root / "_TASK-LOG"
    task_log.mkdir(exist_ok=True)
    (task_log / "actions.jsonl").touch(exist_ok=True)

    now = utc_now()
    today = now[:10]
    slug = slugify(args.slug or args.title)
    task_id = f"{today}-{slug}"
    path = task_log / f"{task_id}.md"
    if path.exists():
        raise SystemExit(f"Task already exists: {path}")

    path.write_text(task_body(task_id, args.title, args.status, now, root, args.source_input), encoding="utf-8")
    append_action(task_log, task_id, args.status, now, f"Created task: {args.title}")
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
