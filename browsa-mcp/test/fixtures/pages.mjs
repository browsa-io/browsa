// Pages for the detector tests. `with` pages hold a captcha; `without` pages
// must give nothing: ordinary forms, and pages that only talk about captchas.

const RC_KEY = "6LdAbCdEfGhIjKlMnOpQrStUvWxYz0123456789A";   // 40 characters, not a real key
const RC_KEY2 = "6LfZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210B";
const TS_KEY = "0x4AAAAAAABkMYinukE8nzYS";

export const KEYS = { RC_KEY, RC_KEY2, TS_KEY };

export const withCaptcha = {
  // The page of the live check, as served on 2026-11-21.
  turnstileImplicit: {
    url: "https://captcha-check.browsa.io/",
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Captcha check</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body><main><h1>Captcha check</h1>
<form id="f"><div class="cf-turnstile" data-sitekey="0x4AAAAAAGEprtbosKnaIPao"></div><button type="submit">Check</button></form>
<pre id="out"></pre></main>
<script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();});</script></body></html>`,
  },
  turnstileAttrs: {
    url: "https://shop.example/login",
    html: `<form action="/login" method="post"><input name="email"><input type="password" name="password">
<div class="widget cf-turnstile" data-sitekey="${TS_KEY}" data-action="login" data-cdata="sess-1" data-callback="onTurnstile" data-response-field-name="cf_token"></div>
<button>Sign in</button></form><script src="//challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>`,
  },
  turnstileExplicit: {
    url: "https://app.example/signup",
    html: `<div id="ts"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=go"></script>
<script>function go(){ turnstile.render('#ts', { sitekey: '${TS_KEY}', action: 'signup', cData: 'abc', callback: onDone }); }</script>`,
  },
  // Rendered widget: the key is only in the frame address (the frame sits in a closed shadow root).
  turnstileFrameOnly: {
    url: "https://app.example/contact",
    html: `<form><input type="hidden" name="cf-turnstile-response" value=""><div id="w"></div></form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`,
    resources: [`https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc12/${TS_KEY}/auto/fbE/new/normal/auto/`],
  },
  turnstileNoKey: {
    url: "https://app.example/contact",
    html: `<form><input type="hidden" name="cf-turnstile-response"></form><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`,
  },
  recaptchaV2: {
    url: "https://forum.example/register",
    html: `<script src="https://www.google.com/recaptcha/api.js" async defer></script>
<form method="post"><div class="g-recaptcha" data-sitekey="${RC_KEY}" data-callback="captchaDone"></div><input type="submit"></form>`,
  },
  recaptchaV2InvisibleFrame: {
    url: "https://forum.example/post",
    html: `<form><textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea>
<iframe title="reCAPTCHA" src="https://www.recaptcha.net/recaptcha/api2/anchor?ar=1&amp;k=${RC_KEY}&amp;co=aHR0cHM6&amp;hl=en&amp;size=invisible&amp;cb=x1"></iframe></form>
<script src="https://www.recaptcha.net/recaptcha/api.js?render=explicit"></script>`,
  },
  recaptchaV2Explicit: {
    url: "https://forum.example/a",
    html: `<div id="rc"></div><script src="https://www.google.com/recaptcha/api.js?onload=cb&render=explicit"></script>
<script>function cb(){ grecaptcha.render('rc', { 'sitekey' : '${RC_KEY}', 'callback' : verifyCallback, 'theme' : 'dark' }); }</script>`,
  },
  recaptchaV3: {
    url: "https://store.example/checkout",
    html: `<script src="https://www.google.com/recaptcha/api.js?render=${RC_KEY}"></script>
<script>function pay(){ grecaptcha.ready(function(){ grecaptcha.execute('${RC_KEY}', {action: 'checkout'}).then(function(t){ send(t); }); }); }</script>
<button onclick="pay()">Pay</button>`,
  },
  recaptchaV3Enterprise: {
    url: "https://store.example/login",
    html: `<script src="https://www.google.com/recaptcha/enterprise.js?render=${RC_KEY2}"></script>
<script>grecaptcha.enterprise.ready(() => grecaptcha.enterprise.execute("${RC_KEY2}", { action: "LOGIN" }).then(send));</script>`,
  },
  recaptchaV2Enterprise: {
    url: "https://bank.example/",
    html: `<div class="g-recaptcha" data-sitekey="${RC_KEY2}"></div><script src="https://www.google.com/recaptcha/enterprise.js"></script>`,
  },
  cloudflareCheck: {
    url: "https://protected.example/products",
    html: `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><noscript>Enable JavaScript and cookies to continue</noscript></div>
<script>(function(){window._cf_chl_opt={cvId:'3',cZone:'protected.example',cType:'managed',cRay:'8e1'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8e1';document.head.appendChild(a);})();</script></body></html>`,
  },
  hcaptcha: {
    url: "https://x.example/join",
    html: `<script src="https://js.hcaptcha.com/1/api.js" async defer></script><form><div class="h-captcha" data-sitekey="5d7f2b1c-0a1b-4c2d-9e3f-112233445566"></div></form>`,
  },
  geetestV4: {
    url: "https://x.example/login",
    html: `<div id="captcha"></div><script src="https://static.geetest.com/v4/gt4.js"></script>
<script>initGeetest4({ captchaId: "54088bb07d2df3c46b79f80300b0abbe", product: "bind" }, function (c) { c.showCaptcha(); });</script>`,
  },
  awsWaf: {
    url: "https://x.example/",
    html: `<div id="captcha-container"></div><script src="https://b82b1763d1c3.eu-west-1.captcha-sdk.awswaf.com/b82b1763d1c3/jsapi.js"></script>
<script>AwsWafCaptcha.renderCaptcha(document.getElementById('captcha-container'), { apiKey: 'k', onSuccess: ok });</script>`,
  },
  dataDome: {
    url: "https://x.example/item/1",
    html: `<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&amp;hash=789&amp;cid=abc&amp;t=fe" width="100%" height="100%"></iframe></body></html>`,
  },
  imageText: {
    url: "https://old.example/register",
    html: `<form action="/register" method="post"><input name="user"><img id="captchaImage" src="/captcha.php?r=8812" alt="security image">
<input type="text" name="captcha_code" placeholder="Type the characters"><button>Register</button></form>`,
  },
  imageTextInline: {
    url: "https://old.example/vote",
    html: `<form><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"><input name="captcha" type="text"></form>`,
  },
  arkoseAndPx: {
    url: "https://x.example/signup",
    html: `<div id="FunCaptcha"></div><iframe src="https://client-api.arkoselabs.com/fc/gc/?token=1"></iframe><div id="px-captcha"></div>
<script src="https://client.px-cloud.net/PXabc123/main.min.js"></script><altcha-widget challengeurl="/altcha"></altcha-widget>`,
  },
  twoWidgets: {
    url: "https://x.example/both",
    html: `<form><div class="cf-turnstile" data-sitekey="${TS_KEY}"></div></form>
<form><div class="g-recaptcha" data-sitekey="${RC_KEY}"></div></form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><script src="https://www.google.com/recaptcha/api.js"></script>`,
  },
  turnstileTestKey: {
    url: "https://demo.example/",
    html: `<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`,
  },
};

export const withoutCaptcha = {
  loginForm: `<!doctype html><html><head><title>Sign in</title><link rel="stylesheet" href="/app.css"></head><body>
<form action="/session" method="post"><label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password"></label><input type="hidden" name="csrf_token" value="a1b2c3">
<label><input type="checkbox" name="remember"> Remember me</label><button type="submit">Sign in</button></form>
<script src="/static/app.js"></script></body></html>`,
  // a two-step code field next to an avatar: an input named "code" and an image, no captcha
  otpForm: `<form action="/verify"><img src="/img/avatar-42.png" alt="Your avatar"><p>Enter the code we sent you</p>
<input type="text" name="code" placeholder="6-digit code" inputmode="numeric"><button>Verify</button></form>`,
  // an article about captchas: the word everywhere, in text, headings, links, a class name and an image
  article: `<html><head><title>What is a CAPTCHA? reCAPTCHA, hCaptcha and Turnstile compared</title>
<meta name="description" content="How captcha services like reCAPTCHA and Cloudflare Turnstile work"></head>
<body class="post captcha-article"><h1>What is a CAPTCHA?</h1>
<p>A captcha tells people from bots. Google's reCAPTCHA shows a checkbox; Cloudflare Turnstile often shows nothing; hCaptcha shows pictures.
GeeTest uses a slider. To add reCAPTCHA you put a div with class g-recaptcha and a data-sitekey on the page.</p>
<img src="/blog/img/recaptcha-checkbox-screenshot.png" alt="The reCAPTCHA checkbox" class="captcha-figure">
<a href="https://www.google.com/recaptcha/about/">reCAPTCHA</a> <a href="https://www.cloudflare.com/products/turnstile/">Turnstile</a>
<form action="/search"><input type="text" name="q" placeholder="Search text"></form>
<form action="/subscribe"><input type="email" name="email"><button>Subscribe</button></form></body></html>`,
  // documentation with code samples: the markup of a widget, shown, not rendered
  docsWithSamples: `<html><body><h2>Add the widget</h2>
<pre><code class="language-html">&lt;script src="https://challenges.cloudflare.com/turnstile/v0/api.js"&gt;&lt;/script&gt;
&lt;div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMYinukE8nzYS"&gt;&lt;/div&gt;</code></pre>
<pre><div class="g-recaptcha" data-sitekey="6LdAbCdEfGhIjKlMnOpQrStUvWxYz0123456789A"></div></pre>
<code><script src="https://www.google.com/recaptcha/api.js"></script></code>
<textarea readonly><div class="h-captcha" data-sitekey="5d7f2b1c-0a1b-4c2d-9e3f-112233445566"></div></textarea>
<!-- <div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMYinukE8nzYS"></div> -->
<template><div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMYinukE8nzYS"></div></template>
<script type="application/ld+json">{"@type":"HowTo","text":"call turnstile.render('#x', {sitekey: '0x4AAAAAAABkMYinukE8nzYS'}) and grecaptcha.execute('6LdAbCdEfGhIjKlMnOpQrStUvWxYz0123456789A')"}</script>
</body></html>`,
  // an ordinary page behind Cloudflare: its background script is there, no check is shown
  behindCloudflare: `<html><head><title>Acme: products</title></head><body><h1>Products</h1>
<script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'8e1',t:'MTcz'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}})();</script>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`,
  // an AWS-protected page after its silent check: the challenge script, no captcha
  awsSilent: `<html><body><script src="https://b82b1763d1c3.token.awswaf.com/b82b1763d1c3/challenge.js"></script><h1>Welcome</h1></body></html>`,
  // class names that look like a provider's, with nothing from the provider
  lookalikeClasses: `<div class="geetest_holder geetest_wind"></div><div class="amzn-captcha-root"></div><div class="recaptcha-terms">This site is protected by reCAPTCHA</div>
<img src="/img/recaptcha-logo.svg" alt="captcha logo"><input type="text" name="comment_text">`,
  // a picture named captcha on a page whose only text field is a search box in another form
  captchaPictureNoField: `<form action="/search"><input type="text" name="search_text"></form>
<article><img src="/uploads/funny-captcha-fails.jpg" alt="Funny captcha fails"></article>`,
  empty: "",
  notHtml: "{\"error\": \"captcha required\", \"captcha\": true}",
};
