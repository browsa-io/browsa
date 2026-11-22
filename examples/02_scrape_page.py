"""Scrape one page: the rendered page as Markdown, in one call. No model involved.

Cost: 1 credit per page.

Run:
    pip install browsa
    BROWSA_API_KEY=agt_live_... python 02_scrape_page.py [url]

Without `formats` the answer carries the rendered `html`; `formats=["markdown"]` asks for Markdown.
"""
import sys

from browsa import Client


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://example.com/"
    client = Client()  # reads BROWSA_API_KEY
    page = client.scrape(url, formats=["markdown"])
    content = page.get("markdown") or page.get("html") or ""
    print("url:", page.get("url"), "| HTTP", page.get("http_status"), "| blocked:", page.get("blocked"))
    print("credits:", page.get("cost_credits"))
    print(content[:500])


if __name__ == "__main__":
    main()
