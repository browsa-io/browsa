from __future__ import annotations

import pytest
from browsa import BrowsaError

from langchain_browsa import BrowsaLoader

from .conftest import JOB_ID, FakeHTTP, scrape_payload


def _batch_job(kind: str, items_key: str, items: list, status: str = "completed") -> dict:
    return {
        "id": JOB_ID,
        "status": status,
        "kind": kind,
        "step_count": 0,
        "progress_done": len(items),
        "progress_total": len(items),
        "outcome": "completed" if status == "completed" else "failed",
        "error_code": None if status == "completed" else "UPSTREAM_UNAVAILABLE",
        "result": {items_key: items} if status == "completed" else None,
    }


PAGES = [
    {"url": "https://example.com/", "status": "completed", "data": scrape_payload("https://example.com/")},
    {
        "url": "https://example.com/broken",
        "status": "failed",
        "error_code": "TARGET_UNREACHABLE",
        "error_message": "DNS",
    },
    {
        "url": "https://example.com/a",
        "status": "completed",
        "data": scrape_payload("https://example.com/a", markdown="# A", links=["https://example.com/"]),
    },
]


def test_scrape_single_url(fake_http: FakeHTTP) -> None:
    docs = BrowsaLoader("https://example.com").load()
    assert len(docs) == 1
    d = docs[0]
    assert d.page_content.startswith("# Example Domain")
    assert d.metadata["source"] == "https://example.com"
    assert d.metadata["requested_url"] == "https://example.com"
    assert d.metadata["http_status"] == 200
    assert d.metadata["title"] == "Example Domain"
    assert d.metadata["mode"] == "scrape"
    (req,) = fake_http.calls("POST", "/v1/quick/scrape")
    assert req.body == {"url": "https://example.com", "formats": ["markdown"]}


def test_scrape_many_urls_lazily(fake_http: FakeHTTP) -> None:
    loader = BrowsaLoader(["https://a.example", "https://b.example"], wait_ms=100)
    it = loader.lazy_load()
    first = next(it)
    assert first.metadata["source"] == "https://a.example"
    assert len(fake_http.calls("POST", "/v1/quick/scrape")) == 1
    rest = list(it)
    assert [d.metadata["source"] for d in rest] == ["https://b.example"]
    assert fake_http.calls("POST", "/v1/quick/scrape")[1].body["wait_ms"] == 100


def test_text_content_format(fake_http: FakeHTTP) -> None:
    docs = BrowsaLoader("https://example.com", content_format="text", formats=["links"]).load()
    assert docs[0].page_content.startswith("Example Domain This domain")
    assert fake_http.calls("POST", "/v1/quick/scrape")[0].body["formats"] == ["links", "text"]


def test_crawl(fake_http: FakeHTTP) -> None:
    fake_http.add("POST", r"^/v1/quick/crawl$", {"job_id": JOB_ID, "status": "queued", "kind": "crawl"})
    fake_http.add("GET", rf"^/v1/jobs/{JOB_ID}$", _batch_job("crawl", "pages", PAGES))
    loader = BrowsaLoader("https://example.com", mode="crawl", max_pages=5, max_depth=2)
    docs = loader.load()
    assert [d.metadata["source"] for d in docs] == ["https://example.com/", "https://example.com/a"]
    assert all(d.metadata["job_id"] == JOB_ID for d in docs)
    assert docs[1].metadata["links"] == ["https://example.com/"]
    (req,) = fake_http.calls("POST", "/v1/quick/crawl")
    assert req.query == {"async": "true"}
    assert req.body == {
        "start_url": "https://example.com",
        "max_pages": 5,
        "max_depth": 2,
        "formats": ["markdown"],
    }


def test_batch(fake_http: FakeHTTP) -> None:
    fake_http.add("POST", r"^/v1/quick/batch$", {"job_id": JOB_ID, "status": "queued", "kind": "batch"})
    fake_http.add("GET", rf"^/v1/jobs/{JOB_ID}$", _batch_job("batch", "items", PAGES))
    docs = BrowsaLoader(["https://example.com/", "https://example.com/broken", "https://example.com/a"], mode="batch").load()
    assert len(docs) == 2
    (req,) = fake_http.calls("POST", "/v1/quick/batch")
    assert req.body["urls"][1] == "https://example.com/broken"
    assert req.body["formats"] == ["markdown"]


def test_failed_job_raises(fake_http: FakeHTTP) -> None:
    fake_http.add("POST", r"^/v1/quick/crawl$", {"job_id": JOB_ID, "status": "queued"})
    fake_http.add("GET", rf"^/v1/jobs/{JOB_ID}$", _batch_job("crawl", "pages", [], status="failed"))
    with pytest.raises(BrowsaError, match="UPSTREAM_UNAVAILABLE"):
        BrowsaLoader("https://example.com", mode="crawl").load()


def test_bad_arguments() -> None:
    with pytest.raises(ValueError):
        BrowsaLoader([])
    with pytest.raises(ValueError):
        BrowsaLoader(["https://a.example", "https://b.example"], mode="crawl")
    with pytest.raises(ValueError):
        BrowsaLoader("https://a.example", mode="pdf")  # type: ignore[arg-type]


def test_missing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BROWSA_API_KEY")
    with pytest.raises(ValueError, match="BROWSA_API_KEY"):
        BrowsaLoader("https://example.com")


async def test_async_scrape(fake_http: FakeHTTP) -> None:
    docs = [d async for d in BrowsaLoader(["https://a.example", "https://b.example"]).alazy_load()]
    assert [d.metadata["source"] for d in docs] == ["https://a.example", "https://b.example"]


async def test_async_crawl(fake_http: FakeHTTP) -> None:
    fake_http.add("POST", r"^/v1/quick/crawl$", {"job_id": JOB_ID, "status": "queued"})
    fake_http.add("GET", rf"^/v1/jobs/{JOB_ID}$", _batch_job("crawl", "pages", PAGES))
    docs = await BrowsaLoader("https://example.com", mode="crawl").aload()
    assert len(docs) == 2
