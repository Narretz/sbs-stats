"""Shared diagnostics sink for the ingest scripts.

Every ingest script needs to say "this looks wrong, a human should read it".
Before this module there were three ways to do that and they behaved
differently in CI:

  - `logging.warning(...)`      → stderr only; invisible unless you open the
                                  step log and scroll
  - `print("WARNING: ...")`     → stdout only; same
  - `print("::warning ...")`    → a real GitHub annotation, but hand-rolled
                                  escaping at each call site, and it fires
                                  during local runs and tests too

So the same class of finding surfaced or vanished depending on which script
happened to find it. `scripts/gsua`'s parser had been dropping per-direction
counts for two years partly because its warnings only ever reached stderr.

The fix is one funnel: call sites keep using the stdlib logger, and this module
adds a JSONL sink when `INGEST_LOG` names a file. `scripts/annotate_log.py`
reads that file after the run and turns it into annotations. The indirection
buys three things a direct `print("::warning")` can't:

  - dedup and capping need the whole set, which only exists at the end
  - workflow commands must be one clean line on stdout, which is awkward for a
    script whose stdout is piped, teed, or interleaved with progress output
  - nothing is emitted during local runs, imports, or pytest, because nothing
    sets INGEST_LOG there

Usage:

    from ingest_log import get_logger, ann        # after the sys.path shim
    log = get_logger(__name__)

    log.warning("combat_engagements is NULL on an operational report")
    log.warning(msg, extra=ann(title="piterfm added a CSV column"))
    log.warning(msg, extra=ann(level="notice"))   # advisory, not a warning

`ann()` is optional. Without it a record is annotated at the level implied by
its log level, titled by its logger name, and anchored at the file and line
that logged it. The logger NAME is therefore user-visible — it becomes the
annotation title — so the ingest scripts pass a short dataset name ("gsua",
"ru-mod") rather than the usual `__name__`.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

# Repo root, so annotations carry a path GitHub can link to. This file lives at
# <root>/scripts/ingest_log.py; resolve() first so a symlinked checkout or a
# worktree still lands on the real tree.
REPO_ROOT = Path(__file__).resolve().parent.parent

# Console format kept byte-identical to what the scripts printed before, so
# adopting this module doesn't churn every log line in the CI transcript.
CONSOLE_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"

# Env var naming the JSONL sink. Unset (the local/pytest case) = console only.
SINK_ENV = "INGEST_LOG"

# logging level → GitHub annotation level, when the record doesn't override it.
_DEFAULT_ANNOTATION = {
    logging.WARNING: "warning",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}

_ANNOTATION_LEVELS = ("notice", "warning", "error")

# Records below this never reach the sink — INFO is progress output, not a
# finding, and a backfill emits tens of thousands of lines of it.
SINK_LEVEL = logging.WARNING


def ann(
    *,
    level: str | None = None,
    title: str | None = None,
    file: str | None = None,
    line: int | None = None,
) -> dict:
    """Build the `extra=` payload that steers one record's annotation.

    `level` overrides the logging-level mapping — pass "notice" for a finding
    that is genuinely advisory, where a yellow warning would train people to
    ignore the panel. `file` / `line` override the call site, for a check whose
    interesting location is elsewhere (a parser regex, not the sanity check
    that noticed).
    """
    if level is not None and level not in _ANNOTATION_LEVELS:
        raise ValueError(f"level must be one of {_ANNOTATION_LEVELS}, got {level!r}")
    payload = {"level": level, "title": title, "file": file, "line": line}
    return {"ingest_ann": {k: v for k, v in payload.items() if v is not None}}


class JsonlSinkHandler(logging.Handler):
    """Append one JSON object per record to the sink file.

    Opened per-record in append mode rather than held open: the ingest scripts
    are short-lived, several of them fork subprocesses, and an interrupted run
    should still leave every record already emitted readable. The volume is
    warnings only, so the open/close cost is irrelevant.
    """

    def __init__(self, path: Path, level: int = SINK_LEVEL) -> None:
        super().__init__(level=level)
        self.path = path

    def emit(self, record: logging.LogRecord) -> None:
        try:
            override = getattr(record, "ingest_ann", {}) or {}
            try:
                where = str(Path(record.pathname).resolve().relative_to(REPO_ROOT))
            except ValueError:
                # Logged from outside the repo (a dependency); no useful anchor.
                where = None
            # An overridden `file` without a `line` means the interesting
            # location is a file, not a line in it — keeping the call site's
            # line number would anchor the annotation to an unrelated line of
            # a different file.
            if "file" in override and "line" not in override:
                line = None
            else:
                line = override.get("line", record.lineno)
            entry = {
                "level": override.get(
                    "level", _DEFAULT_ANNOTATION.get(record.levelno, "warning")
                ),
                "title": override.get("title", record.name),
                "file": override.get("file", where),
                "line": line,
                "message": record.getMessage(),
            }
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:  # pragma: no cover - logging must never raise
            self.handleError(record)


def get_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """Return a logger wired to stderr and, when INGEST_LOG is set, the sink.

    Idempotent: safe to call from several modules in one process, and safe to
    call again after pytest has swapped the environment out from under it.
    """
    root = logging.getLogger()
    root.setLevel(level)

    # Identify our own console handler by a marker rather than by type: pytest's
    # capture plugin attaches a logging.StreamHandler subclass to the root
    # logger, and an isinstance check would mistake it for ours and leave the
    # run with no console output at all.
    if not any(getattr(h, "_ingest_console", False) for h in root.handlers):
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter(CONSOLE_FORMAT))
        console._ingest_console = True
        root.addHandler(console)

    sink_path = os.environ.get(SINK_ENV)
    existing = next(
        (h for h in root.handlers if isinstance(h, JsonlSinkHandler)), None
    )
    if sink_path:
        if existing is None:
            root.addHandler(JsonlSinkHandler(Path(sink_path)))
        elif str(existing.path) != sink_path:
            root.removeHandler(existing)
            root.addHandler(JsonlSinkHandler(Path(sink_path)))
    elif existing is not None:
        root.removeHandler(existing)

    return logging.getLogger(name)
