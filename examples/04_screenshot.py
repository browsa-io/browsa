"""Take a PNG screenshot of a page and save it to a file.

Cost: 1 credit per page.

Run:
    pip install browsa
    BROWSA_API_KEY=agt_live_... python 04_screenshot.py [url] [out.png]
"""
import base64
import sys

from browsa import Client


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://example.com/"
    out = sys.argv[2] if len(sys.argv) > 2 else "screenshot.png"
    client = Client()  # reads BROWSA_API_KEY
    shot = client.screenshot(url, full_page=True)
    png = base64.b64decode(shot["screenshot_png_b64"])
    with open(out, "wb") as f:
        f.write(png)
    print(f"saved {out} ({len(png)} bytes) | credits: {shot.get('cost_credits')}")


if __name__ == "__main__":
    main()
