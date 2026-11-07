"""
Discovery filter tests for scripts/sbu_alfa/discover.py: every known recap
slug matches, unrelated SBU news doesn't. The parse gate behind the filter
keeps a false positive out of the DB, but a false negative is a recap never
fetched — the October 2026 slug dropped "pidrozdiliv" and slipped through.

Run with: pytest scripts/sbu_alfa/test_discover.py -q
"""
from __future__ import annotations

import pytest

import discover

RECAPS = [
    "/novyny/alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-tretii-misiats-pospil-video",
    "/novyny/voiny-alfy-sbu-top1-sered-pidrozdiliv-syl-oborony-za-rezultatamy-boiovoi-roboty-u-kvitni-video",
    "/novyny/alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-za-kilkistiu-urazhenykh-tsilei-u-berezni-video",
    "/novyny/alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-shostyi-misiats-pospil",
    "/novyny/visim-misiatsiv-liderstva-alfy-sbu-top1-sered-syl-oborony-video",
    # Hypothetical: a month the unit isn't first, or the rank left out.
    "/novyny/alfa-sbu-top3-sered-pidrozdiliv-syl-oborony-u-lystopadi",
    "/novyny/alfa-sbu-u-top-sered-syl-oborony-za-pidsumkamy-hrudnia",
    "/novyny/alfa-sbu-druha-sered-syl-oborony-za-kilkistiu-urazhenykh-tsilei",
]

OTHER_NEWS = [
    "/novyny/sbu-identyfikuvala-ponad-100-osib-yaki-braly-uchast-u-sutychkakh-v-petropavlivskii-borshchahivtsi",
    "/novyny/sbu-i-dbr-vykryly-rosiiskoho-krota-u-lavakh-zsu-yakyi-dlia-konspiratsii-zminyv-77-telefonnykh-nomeriv",
    "/novyny/alfa-sbu-urazyla-npz-u-rf-video",
    # "top" must be the word, not the start of one.
    "/novyny/alfa-sbu-topovi-operatsii-tyzhnia",
    # The ranking without the unit.
    "/novyny/sbu-top1-sered-syl-oborony-za-pidsumkamy-misiatsia",
]


@pytest.mark.parametrize("slug", RECAPS)
def test_recap_slugs_match(slug):
    assert discover.SLUG_FILTER.search(slug)


@pytest.mark.parametrize("slug", OTHER_NEWS)
def test_other_news_does_not_match(slug):
    assert not discover.SLUG_FILTER.search(slug)


def test_listing_url_keeps_its_trailing_slash():
    # `/novyny` without it is 403'd by Akamai; see LISTING_URL.
    assert discover.LISTING_URL.endswith("/novyny/")


def test_gate_turns_away_a_story_that_only_names_a_month(monkeypatch, tmp_path):
    """A slug the loose filter lets through, with a body that names a month and
    a figure: parse() calls that monthly, the counter floor doesn't."""
    body = "<p>У жовтні 2026 року спецпризначенці «Альфи» уразили 3 НПЗ та понад 100 окупантів.</p>"
    monkeypatch.setattr(discover.ingest, "_load", lambda url: (url, body.encode()))
    out = tmp_path / "sbu-alfa.db"
    assert discover.ingest_url("https://ssu.gov.ua/novyny/alfa-sbu-syl-oborony-x", out, dry_run=False) == "skipped"
    assert not out.exists()
