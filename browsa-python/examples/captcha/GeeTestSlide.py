"""GeeTestSlide: how far to drag a GeeTest slide puzzle, worked out from its own pictures. You drag.

    v3:  BROWSA_API_KEY=agt_live_... python GeeTestSlide.py 3 bg.webp fullbg.webp
    v4:  BROWSA_API_KEY=agt_live_... python GeeTestSlide.py 4 bg.png slice.png 80 300
    add --all for every parameter

v3 takes the two pictures GeeTest serves (the one with the gap and the full one), still cut into
shuffled strips, exactly as downloaded. v4 takes the background, the piece's own PNG, the piece's top
offset and the background's width on the page, both in CSS px.
Solution: {"distance": 142.0, "x": 151, ...}; drag the handle `distance` CSS px.
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import b64file, cli, show

TYPE = "GeeTestSlide"


def basic(background: str, full: str) -> dict:
    """GeeTest v3."""
    return {"type": TYPE, "version": 3, "imageBackground": background, "imageFull": full}


def all_options(background: str, full: str, css_width: float = 260, website_url: str = "https://example.com/") -> dict:
    """GeeTest v3 with every v3 parameter."""
    return {
        "type": TYPE,
        "version": 3,
        "imageBackground": background,
        "imageFull": full,
        "cssWidth": css_width,         # the background's width on the page, CSS px
        "shuffled": True,              # False when you already put the strips in order
        "websiteURL": website_url,     # only used for your per-site limits
    }


def basic_v4(background: str, piece: str, top: float, bg_css_width: float) -> dict:
    """GeeTest v4."""
    return {"type": TYPE, "version": 4, "imageBackground": background, "imageSlice": piece, "top": top,
            "bgCssWidth": bg_css_width}


def all_options_v4(background: str, piece: str, top: float, bg_css_width: float, slice_css_width: float = 60,
                   website_url: str = "https://example.com/") -> dict:
    """GeeTest v4 with every v4 parameter."""
    return {
        "type": TYPE,
        "version": 4,
        "imageBackground": background,
        "imageSlice": piece,
        "top": top,                          # the piece's top offset, CSS px
        "bgCssWidth": bg_css_width,          # the background's width on the page, CSS px
        "sliceCssWidth": slice_css_width,    # the piece's width on the page, CSS px
        "websiteURL": website_url,           # only used for your per-site limits
    }


if __name__ == "__main__":
    everything, (version, *rest) = cli(__doc__, 3)
    if version == "3":
        pictures = [b64file(p) for p in rest[:2]]
        show(all_options(*pictures) if everything else basic(*pictures))
    else:
        cli(__doc__, 5)
        v4 = (b64file(rest[0]), b64file(rest[1]), float(rest[2]), float(rest[3]))
        show(all_options_v4(*v4) if everything else basic_v4(*v4))
