from __future__ import annotations

import json
import pathlib

import pytest
from fastapi.testclient import TestClient

from tpl.api import create_app
from tpl.config import reset_settings
from tpl.extraction import ExtractionError, extract
from tpl.pipeline import AnalysisError, analyse
from tpl.preprocessing import encode_variation_selectors

TOP_LEVEL_KEYS = {
    "schema_version",
    "engine",
    "input",
    "scores",
    "signals",
    "payloads",
    "segments",
    "style_profiles",
    "features",
    "perplexity",
    "findings",
    "technical_report_markdown",
    "warnings",
    "timings_ms",
    "model_metrics",
}


def test_pipeline_returns_full_contract(human_text):
    result = analyse(human_text, "forensic")
    assert set(result) >= TOP_LEVEL_KEYS
    assert result["schema_version"] == "1.0"
    assert result["engine"]["mode"] == "forensic"
    assert 0.0 <= result["scores"]["risk"]["value"] <= 1.0
    assert result["input"]["sha256"]
    assert result["timings_ms"]["total"] >= 0


def test_pipeline_is_json_serialisable(assistant_text):
    payload = json.dumps(analyse(assistant_text, "forensic"))
    assert len(payload) > 1000


def test_segment_offsets_are_valid_for_the_original_text(human_text):
    result = analyse(human_text, "forensic")
    assert result["segments"]
    for segment in result["segments"]:
        assert 0 <= segment["start"] < segment["end"] <= len(human_text)
        assert 0.0 <= segment["llm_likelihood"] <= 1.0


def test_quick_mode_skips_optional_work(human_text):
    quick = analyse(human_text, "quick")
    assert quick["style_profiles"]["matches"] == []
    assert quick["perplexity"]["available"] is False
    forensic = analyse(human_text, "forensic")
    assert forensic["style_profiles"]["matches"]


def test_payload_surfaces_in_findings_and_report():
    text = "Quarterly results are attached." + encode_variation_selectors("leak-42")
    result = analyse(text, "forensic")
    assert result["payloads"][0]["text"] == "leak-42"
    assert result["scores"]["watermark"]["label"] == "payload_recovered"
    assert result["scores"]["risk"]["value"] >= 0.9
    assert any(f["severity"] == "critical" for f in result["findings"])
    assert "leak-42" in result["technical_report_markdown"]


def test_report_contains_every_section(human_text):
    report = analyse(human_text, "forensic")["technical_report_markdown"]
    for heading in (
        "# Text provenance report",
        "## Verdicts",
        "## Signals",
        "## Findings",
        "## Style analysis",
        "## Segment breakdown",
        "## Feature values",
        "## Method and limitations",
    ):
        assert heading in report


def test_pipeline_rejects_empty_and_oversized_input():
    with pytest.raises(AnalysisError):
        analyse("   ", "forensic")
    with pytest.raises(AnalysisError):
        analyse("word " * 10, "nonsense")  # type: ignore[arg-type]


def test_pipeline_respects_max_chars(monkeypatch):
    monkeypatch.setenv("TPL_MAX_CHARS", "100")
    reset_settings()
    with pytest.raises(AnalysisError):
        analyse("x" * 200, "quick")


def test_short_input_produces_a_warning():
    result = analyse("Short note, only a handful of words in here.", "quick")
    assert result["warnings"]


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------
def test_extract_plain_text():
    result = extract(b"hello world", "note.txt")
    assert result.text == "hello world"
    assert result.format == "text"


def test_extract_html_strips_markup():
    html = b"<html><head><style>p{}</style></head><body><p>Hello</p><p>World</p></body></html>"
    result = extract(html, "page.html")
    assert "Hello" in result.text and "World" in result.text
    assert "<p>" not in result.text


def test_extract_json_collects_strings():
    result = extract(b'{"a": "one", "b": ["two", 3]}', "data.json")
    assert "one" in result.text and "two" in result.text


def test_extract_rejects_unknown_and_empty():
    with pytest.raises(ExtractionError):
        extract(b"", "empty.txt")
    with pytest.raises(ExtractionError):
        extract(b"data", "archive.rar")


def test_extract_truncates_long_documents():
    result = extract(b"a" * 500, "long.txt", max_chars=100)
    assert result.truncated is True
    assert len(result.text) == 100


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------
@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_health_and_version(client):
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.headers["x-request-id"]

    version = client.get("/version").json()
    assert version["engine"] == "text-provenance-lab"
    assert version["style_model"]["trained"] is False


def test_capabilities_lists_modes(client):
    body = client.get("/capabilities").json()
    assert body["modes"] == ["quick", "forensic"]
    assert body["auth_required"] is False
    assert ".pdf" in body["supported_uploads"]


def test_analyze_endpoint(client, assistant_text):
    response = client.post(
        "/analyze",
        json={"text": assistant_text, "mode": "quick", "client_reference": "abc123"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["client_reference"] == "abc123"
    assert body["request_id"]
    assert set(body["result"]) >= TOP_LEVEL_KEYS


def test_analyze_rejects_empty_text(client):
    response = client.post("/analyze", json={"text": "  ", "mode": "quick"})
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_input"


def test_analyze_validates_mode(client):
    response = client.post("/analyze", json={"text": "hello", "mode": "turbo"})
    assert response.status_code == 422


def test_api_key_is_enforced_when_configured(monkeypatch, assistant_text):
    monkeypatch.setenv("TPL_API_TOKEN", "s3cret-token")
    reset_settings()
    client = TestClient(create_app())

    assert client.post("/analyze", json={"text": assistant_text}).status_code == 401
    assert (
        client.post(
            "/analyze",
            json={"text": assistant_text},
            headers={"X-API-Key": "wrong-token!!"},
        ).status_code
        == 401
    )
    ok = client.post(
        "/analyze",
        json={"text": assistant_text, "mode": "quick"},
        headers={"X-API-Key": "s3cret-token"},
    )
    assert ok.status_code == 200
    assert client.get("/health").status_code == 200  # meta stays open


def test_extract_endpoint(client):
    response = client.post(
        "/extract", files={"file": ("note.txt", b"hello from a file", "text/plain")}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "hello from a file"
    assert body["chars"] == 17


def test_extract_endpoint_rejects_large_files(monkeypatch, client):
    monkeypatch.setenv("TPL_MAX_UPLOAD_BYTES", "16")
    reset_settings()
    response = client.post("/extract", files={"file": ("note.txt", b"x" * 64, "text/plain")})
    assert response.status_code == 413


class TestSanitizeEndpoint:
    def test_requires_a_key(self, monkeypatch):
        monkeypatch.setenv("TPL_API_TOKEN", "s3cret-token")
        reset_settings()
        guarded = TestClient(create_app())
        assert guarded.post("/sanitize", json={"text": "x"}).status_code == 401
        allowed = guarded.post(
            "/sanitize", json={"text": "x"}, headers={"X-API-Key": "s3cret-token"}
        )
        assert allowed.status_code == 200

    def test_strips_a_tag_payload(self, client):
        from tpl.preprocessing import encode_tag_characters

        marked = "Confidential." + encode_tag_characters("id:WF-1")
        response = client.post("/sanitize", json={"text": marked})
        assert response.status_code == 200
        body = response.json()
        assert body["text"] == "Confidential."
        assert body["changed"] is True
        assert body["removed_total"] == len(marked) - len("Confidential.")

    def test_reports_what_it_kept(self, client):
        response = client.post("/sanitize", json={"text": "می‌خواهم"})
        body = response.json()
        assert body["text"] == "می‌خواهم"
        assert body["preserved_total"] == 1
        assert body["warnings"]

    def test_rejects_an_unknown_level(self, client):
        response = client.post("/sanitize", json={"text": "x", "level": "thorough"})
        assert response.status_code == 422


class TestMarkEndpoint:
    DOC = "Zdanie pierwsze. Zdanie drugie. Zdanie trzecie i ostatnie."

    def test_produces_one_distinct_copy_per_recipient(self, client):
        response = client.post(
            "/mark",
            json={"text": self.DOC, "recipients": ["Jan", "Anna"], "template": "WF-{index:03d}"},
        )
        assert response.status_code == 200
        copies = response.json()["copies"]
        assert [c["payload"] for c in copies] == ["WF-001", "WF-002"]
        assert len({c["text"] for c in copies}) == 2
        assert all(c["verified"] for c in copies)

    def test_always_warns_that_pdf_destroys_the_mark(self, client):
        response = client.post("/mark", json={"text": self.DOC, "recipients": ["Jan"]})
        warnings = " ".join(response.json()["warnings"])
        assert "PDF" in warnings
        assert "not secret" in warnings

    def test_rejects_duplicate_recipients(self, client):
        response = client.post("/mark", json={"text": self.DOC, "recipients": ["Jan", "Jan"]})
        assert response.status_code == 422
        assert "distinct" in response.json()["detail"]

    def test_rejects_an_unknown_channel(self, client):
        response = client.post(
            "/mark",
            json={"text": self.DOC, "recipients": ["Jan"], "channel": "steganography"},
        )
        assert response.status_code == 422

    def test_requires_at_least_one_recipient(self, client):
        response = client.post("/mark", json={"text": self.DOC, "recipients": []})
        assert response.status_code == 422


class TestC2paEndpoint:
    FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "c2pa"

    def _post(self, client, name, mime="image/png"):
        return client.post(
            "/c2pa", files={"file": (name, (self.FIXTURES / name).read_bytes(), mime)}
        )

    def test_reads_a_signed_file(self, client):
        response = self._post(client, "ai-generated.png")
        assert response.status_code == 200
        body = response.json()
        assert body["present"] is True
        assert body["integrity"] == "intact"
        assert body["ai_declared"] is True

    def test_separates_integrity_from_trust(self, client):
        body = self._post(client, "ai-generated.png").json()
        assert body["integrity"] == "intact"
        assert body["trust"] == "unrecognised"
        assert any("recognised trust list" in note for note in body["notes"])

    def test_tampering_is_not_reported_as_absence(self, client):
        body = self._post(client, "tampered.png").json()
        assert body["present"] is True
        assert body["integrity"] == "broken"

    def test_a_plain_file_claims_nothing(self, client):
        body = self._post(client, "no-credential.png").json()
        assert body["present"] is False
        assert body["ai_declared"] is None

    def test_capabilities_advertise_c2pa(self, client):
        body = client.get("/capabilities").json()
        assert body["c2pa_enabled"] is True
        assert "application/pdf" in body["c2pa_mime_types"]
        # Without anchors the trust dimension would be a constant.
        assert body["c2pa_trust_anchors"] >= 25
