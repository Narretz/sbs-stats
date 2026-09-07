"""Tests for the shared diagnostics sink and its annotator.

Run from this directory:  pytest -q test_ingest_log.py
"""
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import annotate_log  # noqa: E402
import ingest_log  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_root():
    """get_logger configures the ROOT logger, so every test has to hand it back
    the way it found it or the next test inherits a stray sink."""
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    root.handlers = []
    yield
    root.handlers, root.level = saved_handlers, saved_level


def _sink(tmp_path, monkeypatch):
    path = tmp_path / "ingest.jsonl"
    monkeypatch.setenv(ingest_log.SINK_ENV, str(path))
    return path


def _read(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l]


# ---------------------------------------------------------------------------
# ingest_log
# ---------------------------------------------------------------------------

class TestSink:
    def test_no_sink_without_env(self, tmp_path, monkeypatch, capsys):
        monkeypatch.delenv(ingest_log.SINK_ENV, raising=False)
        log = ingest_log.get_logger("t")
        log.warning("nothing should be written")
        # The console still gets it — a local run must not go quiet.
        assert "nothing should be written" in capsys.readouterr().err
        assert not list(tmp_path.iterdir())

    def test_writes_jsonl_when_env_set(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        ingest_log.get_logger("t").warning("combat_engagements is NULL")
        (entry,) = _read(path)
        assert entry["level"] == "warning"
        assert entry["message"] == "combat_engagements is NULL"
        assert entry["title"] == "t"
        # Anchored at the call site, repo-relative so GitHub can link it.
        assert entry["file"] == "scripts/test_ingest_log.py"
        assert isinstance(entry["line"], int)

    def test_info_is_not_a_finding(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        log = ingest_log.get_logger("t")
        log.info("scraped 42 posts")
        log.warning("something odd")
        assert [e["message"] for e in _read(path)] == ["something odd"]

    def test_error_maps_to_error_level(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        ingest_log.get_logger("t").error("upload failed")
        assert _read(path)[0]["level"] == "error"

    def test_repeated_get_logger_does_not_stack_handlers(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        for _ in range(3):
            ingest_log.get_logger("t")
        ingest_log.get_logger("t").warning("once")
        assert len(_read(path)) == 1

    def test_sink_detaches_when_env_cleared(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        ingest_log.get_logger("t").warning("first")
        monkeypatch.delenv(ingest_log.SINK_ENV)
        ingest_log.get_logger("t").warning("second")
        assert [e["message"] for e in _read(path)] == ["first"]


class TestAnn:
    def test_level_override(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        ingest_log.get_logger("t").warning(
            "only one missile field is set", extra=ingest_log.ann(level="notice")
        )
        assert _read(path)[0]["level"] == "notice"

    def test_title_and_location_override(self, tmp_path, monkeypatch):
        path = _sink(tmp_path, monkeypatch)
        ingest_log.get_logger("t").warning(
            "piterfm added a CSV column",
            extra=ingest_log.ann(
                title="source drift", file="scripts/missile_attacks/ingest.py", line=7
            ),
        )
        entry = _read(path)[0]
        assert entry["title"] == "source drift"
        assert entry["file"] == "scripts/missile_attacks/ingest.py"
        assert entry["line"] == 7

    def test_rejects_unknown_level(self):
        with pytest.raises(ValueError):
            ingest_log.ann(level="critical")


# ---------------------------------------------------------------------------
# annotate_log
# ---------------------------------------------------------------------------

def _write_sink(tmp_path, *entries):
    path = tmp_path / "ingest.jsonl"
    with open(path, "w", encoding="utf-8") as fh:
        for e in entries:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    return path


def _entry(**kw):
    base = {"level": "warning", "title": "t", "file": "scripts/x.py", "line": 1,
            "message": "m"}
    base.update(kw)
    return base


class TestAnnotator:
    def test_missing_sink_is_not_an_error(self, tmp_path, capsys):
        # No findings means no file. That's the common case and must exit 0 —
        # diagnostics can never be why a data update fails.
        assert annotate_log.main([str(tmp_path / "absent.jsonl")]) == 0
        assert "nothing to do" in capsys.readouterr().out

    def test_emits_one_command_per_finding(self, tmp_path, capsys):
        path = _write_sink(tmp_path, _entry(message="a"), _entry(message="b"))
        annotate_log.main([str(path)])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert out == [
            "::warning file=scripts/x.py,line=1,title=t::a",
            "::warning file=scripts/x.py,line=1,title=t::b",
        ]

    def test_duplicates_collapse_with_a_count(self, tmp_path, capsys):
        path = _write_sink(tmp_path, *[_entry(message="same")] * 4)
        annotate_log.main([str(path)])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert out == ["::warning file=scripts/x.py,line=1,title=t::same (×4)"]

    def test_newline_is_escaped(self, tmp_path, capsys):
        # A literal newline would truncate the annotation at the break.
        path = _write_sink(tmp_path, _entry(message="line one\nline two"))
        annotate_log.main([str(path)])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert out == ["::warning file=scripts/x.py,line=1,title=t::line one%0Aline two"]

    def test_property_delimiters_are_escaped(self, tmp_path, capsys):
        path = _write_sink(tmp_path, _entry(title="gsua: drift, maybe"))
        annotate_log.main([str(path)])
        line = next(l for l in capsys.readouterr().out.splitlines() if l.startswith("::"))
        assert "title=gsua%3A drift%2C maybe::" in line

    def test_errors_are_emitted_before_notices(self, tmp_path, capsys):
        path = _write_sink(
            tmp_path,
            _entry(level="notice", message="fyi"),
            _entry(level="error", message="broken"),
        )
        annotate_log.main([str(path)])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert out[0].startswith("::error") and out[1].startswith("::notice")

    def test_caps_per_level(self, tmp_path, capsys):
        path = _write_sink(tmp_path, *[_entry(message=f"m{i}") for i in range(25)])
        annotate_log.main([str(path), "--max-per-level", "3"])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert len(out) == 3

    def test_summary_reports_what_the_cap_hid(self, tmp_path, monkeypatch, capsys):
        summary = tmp_path / "summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
        path = _write_sink(
            tmp_path,
            *[_entry(message=f"m{i}") for i in range(5)],
            *[_entry(message="dupe")] * 3,
        )
        annotate_log.main([str(path), "--max-per-level", "2"])
        text = summary.read_text(encoding="utf-8")
        # 6 distinct findings over 8 occurrences, only 2 annotated.
        assert "| warning | 6 | 8 | 2 (of 6) |" in text
        assert "capped per level" in text

    def test_malformed_line_does_not_lose_its_neighbours(self, tmp_path, capsys):
        path = tmp_path / "ingest.jsonl"
        path.write_text(
            json.dumps(_entry(message="before")) + "\n"
            "{ this is not json\n"
            + json.dumps(_entry(message="after")) + "\n",
            encoding="utf-8",
        )
        annotate_log.main([str(path)])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert len(out) == 2

    def test_end_to_end_through_the_sink(self, tmp_path, monkeypatch, capsys):
        path = _sink(tmp_path, monkeypatch)
        log = ingest_log.get_logger("gsua")
        log.info("progress, not a finding")
        log.warning("unusual direction count (3)")
        log.warning("only one missile field is set", extra=ingest_log.ann(level="notice"))
        capsys.readouterr()
        annotate_log.main([str(path)])
        out = [l for l in capsys.readouterr().out.splitlines() if l.startswith("::")]
        assert len(out) == 2
        assert out[0].startswith("::warning") and "unusual direction count (3)" in out[0]
        assert out[1].startswith("::notice")
