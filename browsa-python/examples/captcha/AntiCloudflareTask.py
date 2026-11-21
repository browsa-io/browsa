"""AntiCloudflareTask: pass a page's Cloudflare "Verify you are human" check and get its cookies.

    BROWSA_API_KEY=agt_live_... python AntiCloudflareTask.py https://example.com/ http://user:pass@host:8080
    add --all for every parameter

A proxy is required: cf_clearance only works from the address that passed the check, so the check is
passed in Phantom through your proxy, and you then send the cookie from that same proxy with the
`userAgent` the solution returns.
The proxy is yours: "http://user:pass@host:port" (or "http:host:port:user:pass"). The fields proxyType,
proxyAddress, proxyPort, proxyLogin and proxyPassword are accepted instead of the one string.
Solution: {"cookies": {"cf_clearance": "..."}, "token": "<cf_clearance>", "type": "challenge", "userAgent": "..."}
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import cli, show

TYPE = "AntiCloudflareTask"
CHROME = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/53"
          "7.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36")


def basic(website_url: str, proxy: str) -> dict:
    return {"type": TYPE, "websiteURL": website_url, "proxy": proxy}


def all_options(website_url: str, proxy: str, user_agent: str = CHROME) -> dict:
    return {
        "type": TYPE,
        "websiteURL": website_url,     # the protected page; http:// or https://, a public site
        "proxy": proxy,
        "userAgent": user_agent,       # a Chrome-family string to wear; send the same one with the cookie
    }


if __name__ == "__main__":
    everything, args = cli(__doc__, 2)
    show(all_options(*args[:2]) if everything else basic(*args[:2]))
