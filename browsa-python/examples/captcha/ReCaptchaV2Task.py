"""ReCaptchaV2Task: a reCAPTCHA v2 token: the checkbox, then the picture puzzle when Google shows one. Solved through your proxy.

    BROWSA_API_KEY=agt_live_... python ReCaptchaV2Task.py https://example.com/login SITE_KEY http://user:pass@host:8080
    add --all for every parameter

Read the site key from the live widget's own requests, not from the page's HTML.
The proxy is yours: "http://user:pass@host:port" (or "http:host:port:user:pass"). The fields proxyType,
proxyAddress, proxyPort, proxyLogin and proxyPassword are accepted instead of the one string.
Solution: {"gRecaptchaResponse": "03AF...", "userAgent": "...", "createTime": 1700000000000}; submit it as g-recaptcha-response
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import cli, show

TYPE = "ReCaptchaV2Task"
CHROME = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/53"
          "7.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36")


def basic(website_url: str, website_key: str, proxy: str) -> dict:
    return {"type": TYPE, "websiteURL": website_url, "websiteKey": website_key, "proxy": proxy}


def all_options(website_url: str, website_key: str, proxy: str,
                invisible: bool = True, api_domain: str = "www.recaptcha.net",
                user_agent: str = CHROME) -> dict:
    return {
        "type": TYPE,
        "websiteURL": website_url,
        "websiteKey": website_key,
        "proxy": proxy,
        "isInvisible": invisible,      # True for the invisible widget (no checkbox)
        "apiDomain": api_domain,       # when the page loads the script from another domain
        "enterprisePayload": {},       # accepted for compatibility, ignored
        "userAgent": user_agent,       # a Chrome-family string to wear; the solution returns the one sent
    }


if __name__ == "__main__":
    everything, args = cli(__doc__, 3)
    show(all_options(*args[:3]) if everything else basic(*args[:3]))
