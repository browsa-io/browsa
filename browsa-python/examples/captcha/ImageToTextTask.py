"""ImageToTextTask: read the characters in a picture captcha. Answered inside createTask.

    BROWSA_API_KEY=agt_live_... python ImageToTextTask.py captcha.png
    BROWSA_API_KEY=agt_live_... python ImageToTextTask.py --all first.png second.png

Solution: {"text": "x7Kp2"} for one picture, {"answers": ["x7Kp2", "9QdL"]} for several.
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import b64file, cli, show

TYPE = "ImageToTextTask"


def basic(picture: str) -> dict:
    """One picture, as base64 (a data: URL works too)."""
    return {"type": TYPE, "body": picture}


def all_options(pictures: list, website_url: str = "https://example.com/signup") -> dict:
    """Up to 9 pictures in one task; the answers come back in the same order."""
    return {
        "type": TYPE,
        "images": pictures,            # instead of "body"
        "module": "common",            # accepted for compatibility, ignored
        "websiteURL": website_url,     # only used for your per-site limits
    }


if __name__ == "__main__":
    everything, paths = cli(__doc__, 1)
    show(all_options([b64file(p) for p in paths]) if everything else basic(b64file(paths[0])))
