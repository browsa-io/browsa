"""ReCaptchaV2Classification: which tiles of a reCAPTCHA v2 picture grid show the object. You click.

    BROWSA_API_KEY=agt_live_... python ReCaptchaV2Classification.py grid.jpg "/m/015qff"
    BROWSA_API_KEY=agt_live_... python ReCaptchaV2Classification.py --all grid.jpg "traffic lights"

`grid.jpg` is the picture as Google serves it (the payload image: 300 px wide for 3x3, 450 px for 4x4,
100 px for one replaced tile). The question is the challenge's "/m/..." id or its plain words.
Solution: {"type": "multi", "objects": [0, 4, 7], "size": 3}, tiles numbered from 0, left to right, top down;
or {"type": "single", "hasObject": true, "size": 1} for one tile.
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import b64file, cli, show

TYPE = "ReCaptchaV2Classification"


def basic(picture: str, question: str) -> dict:
    return {"type": TYPE, "image": picture, "question": question}


def all_options(picture: str, question: str, size: int = 3, website_url: str = "https://example.com/login") -> dict:
    return {
        "type": TYPE,
        "image": picture,
        "question": question,
        "size": size,                  # 1, 3 or 4, when the picture's width does not tell
        "escalate": True,              # stronger model first: use from round 3, or after a refused round
        "websiteURL": website_url,     # only used for your per-site limits
    }


if __name__ == "__main__":
    everything, (path, question) = cli(__doc__, 2)
    show(all_options(b64file(path), question) if everything else basic(b64file(path), question))
