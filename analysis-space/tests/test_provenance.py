from __future__ import annotations

import pathlib

import pytest

from tpl.provenance import inspect_bytes, is_available, supported_mime_types

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "c2pa"

pytestmark = pytest.mark.skipif(not is_available(), reason="c2pa library not installed")


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class TestReadingCredentials:
    def test_a_signed_file_is_reported_as_intact(self):
        result = inspect_bytes(_read("ai-generated.png"), "image/png")
        assert result.present
        assert result.integrity == "intact"
        assert result.generator == "Watermark Finder test fixture"
        assert result.signature_alg == "Es256"

    def test_a_file_without_a_credential_says_so_plainly(self):
        result = inspect_bytes(_read("no-credential.png"), "image/png")
        assert not result.present
        assert result.reason == "no content credential in this file"
        # Absence is not evidence either way, so nothing is claimed.
        assert result.integrity == "unknown"
        assert result.ai_declared is None

    def test_an_unreadable_file_does_not_pretend_to_know_anything(self):
        result = inspect_bytes(b"this is not a png", "image/png")
        assert not result.present
        assert result.integrity == "unknown"


class TestIntegrityAndTrustAreSeparate:
    """Collapsing these into one tick would be a lie in both directions.

    A valid signature from a certificate nobody recognises is not verified
    provenance: anyone can mint a certificate whose common name reads "Adobe
    Inc." An intact file signed by an unknown party is also not tampered with.
    Both facts have to survive to the caller.
    """

    def test_an_unrecognised_signer_is_intact_but_not_trusted(self):
        result = inspect_bytes(_read("ai-generated.png"), "image/png")
        assert result.integrity == "intact"
        assert result.trust == "unrecognised"
        assert result.raw_state == "Valid"
        assert any("not on a recognised trust list" in note for note in result.notes)

    def test_tampering_is_reported_as_broken_not_as_missing(self):
        # A file whose pixels changed after signing must not come back as "no
        # credential": that would let anyone launder provenance by corrupting it.
        result = inspect_bytes(_read("tampered.png"), "image/png")
        assert result.present
        assert result.integrity == "broken"
        assert "assertion.dataHash.mismatch" in result.failures
        assert any("does not match what was signed" in note for note in result.notes)


class TestAiDeclaration:
    """C2PA carries an explicit IPTC field for generative authorship."""

    def test_generative_authorship_is_surfaced(self):
        result = inspect_bytes(_read("ai-generated.png"), "image/png")
        assert result.ai_declared is True
        assert "c2pa.created" in result.actions

    def test_a_camera_capture_is_not_reported_as_ai(self):
        result = inspect_bytes(_read("camera-capture.png"), "image/png")
        assert result.ai_declared is False

    def test_a_missing_credential_declares_nothing(self):
        assert inspect_bytes(_read("no-credential.png"), "image/png").ai_declared is None


class TestCoverage:
    def test_pdf_and_the_common_image_formats_are_supported(self):
        types = supported_mime_types()
        for expected in ("application/pdf", "image/jpeg", "image/png", "video/mp4"):
            assert expected in types
