"""ReCaptchaV3TaskProxyLess: a reCAPTCHA v3 token for a page's site key. Solved from Browsa's own exit; no proxy.

    BROWSA_API_KEY=agt_live_... python ReCaptchaV3TaskProxyLess.py https://example.com/login SITE_KEY
    add --all for every parameter

Read the site key from the live widget's own requests, not from the page's HTML.
Solution: {"gRecaptchaResponse": "03AF...", "userAgent": "...", "createTime": 1700000000000}
Parameters, price and measured pass rate: GET https://captcha.browsa.io/types
"""
from _run import cli, show

TYPE = "ReCaptchaV3TaskProxyLess"
CHROME = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/53"
          "7.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36")


def basic(website_url: str, website_key: str) -> dict:
    return {"type": TYPE, "websiteURL": website_url, "websiteKey": website_key}


def all_options(website_url: str, website_key: str,
                page_action: str = "login", api_domain: str = "www.recaptcha.net", min_score: float = 0.7,
                user_agent: str = CHROME) -> dict:
    return {
        "type": TYPE,
        "websiteURL": website_url,
        "websiteKey": website_key,
        "pageAction": page_action,     # the action the page passes to execute(); default "verify"
        "apiDomain": api_domain,       # when the page loads the script from another domain
        "minScore": min_score,         # accepted, not guaranteed: the score is Google's
        "enterprisePayload": {},       # accepted for compatibility, ignored
        "userAgent": user_agent,       # a Chrome-family string to wear; the solution returns the one sent
    }


if __name__ == "__main__":
    everything, args = cli(__doc__, 2)
    show(all_options(*args[:2]) if everything else basic(*args[:2]))
