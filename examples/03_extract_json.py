"""Extract structured JSON from a page with a JSON Schema, in one call.

Cost: 1 credit per page. The extraction model runs on your own Anthropic key, billed by Anthropic.

Run:
    pip install browsa
    BROWSA_API_KEY=agt_live_... ANTHROPIC_API_KEY=sk-ant-... python 03_extract_json.py [url]
    BROWSA_API_KEY=agt_live_... python 03_extract_json.py [url]        (no model key)

With a model key the answer has `data`, shaped by the schema. Without one it has the page's clean
`text` and your `schema`, for a model of your own; the page still costs 1 credit.
"""
import json
import os
import sys

from browsa import Client

SCHEMA = {
    "type": "object",
    "properties": {
        "books": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "price": {"type": "string"}},
                "required": ["title", "price"],
            },
        },
    },
    "required": ["books"],
}


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://books.toscrape.com/"
    client = Client()  # reads BROWSA_API_KEY
    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    options = {"llm_api_key": llm_key} if llm_key else {}
    result = client.extract(url, schema=SCHEMA, **options)
    if "data" in result:
        print(json.dumps(result["data"], indent=2))
    else:
        print("No model key was given: this is the page's text, to pass to your own model with the schema.")
        print((result.get("text") or "")[:500])
    print("credits:", result.get("cost_credits"))


if __name__ == "__main__":
    main()
