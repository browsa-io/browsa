"""AwsWafClassification: which tiles of an AWS WAF captcha grid show the object. You click.

    BROWSA_API_KEY=agt_live_... python AwsWafClassification.py bed grid.png
    BROWSA_API_KEY=agt_live_... python AwsWafClassification.py --all bed tile1.png tile2.png ... tile9.png

Send the one 3x3 picture, or the 9 tiles separately. Only grid questions: "aws:grid:<object>".
Solution: {"objects": [1, 5, 8]}, tiles numbered from 0.
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import b64file, cli, show

TYPE = "AwsWafClassification"


def basic(pictures: list, thing: str) -> dict:
    return {"type": TYPE, "images": pictures, "question": f"aws:grid:{thing}"}


def all_options(pictures: list, thing: str, website_url: str = "https://example.com/") -> dict:
    return {
        "type": TYPE,
        "images": pictures,
        "question": f"aws:grid:{thing}",
        "websiteURL": website_url,     # only used for your per-site limits
    }


if __name__ == "__main__":
    everything, (thing, *paths) = cli(__doc__, 2)
    pictures = [b64file(p) for p in paths]
    show(all_options(pictures, thing) if everything else basic(pictures, thing))
