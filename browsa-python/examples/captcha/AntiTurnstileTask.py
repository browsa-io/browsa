"""AntiTurnstileTask: a Cloudflare Turnstile token for the widget on a page. Solved through your proxy.

    BROWSA_API_KEY=agt_live_... python AntiTurnstileTask.py https://example.com/login SITE_KEY http://user:pass@host:8080
    add --all for every parameter

Read the site key from the live widget's own requests, not from the page's HTML.
The proxy is yours: "http://user:pass@host:port" (or "http:host:port:user:pass"). The fields proxyType,
proxyAddress, proxyPort, proxyLogin and proxyPassword are accepted instead of the one string.
Solution: {"token": "0.AbC...", "type": "turnstile", "userAgent": "..."}; submit `token` as cf-turnstile-response
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import cli, show

TYPE = "AntiTurnstileTask"
CHROME = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/53"
          "7.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36")


def basic(website_url: str, website_key: str, proxy: str) -> dict:
    return {"type": TYPE, "websiteURL": website_url, "websiteKey": website_key, "proxy": proxy}


def all_options(website_url: str, website_key: str, proxy: str,
                action: str = "login", cdata: str = "session-123",
                user_agent: str = CHROME) -> dict:
    return {
        "type": TYPE,
        "websiteURL": website_url,
        "websiteKey": website_key,
        "proxy": proxy,
        "metadata": {"action": action,   # the widget's data-action, when it has one
                     "cdata": cdata},     # the widget's data-cdata, when it has one
        "userAgent": user_agent,       # a Chrome-family string to wear; the solution returns the one sent
    }


if __name__ == "__main__":
    everything, args = cli(__doc__, 3)
    show(all_options(*args[:3]) if everything else basic(*args[:3]))
