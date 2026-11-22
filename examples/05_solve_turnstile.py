"""Solve a Cloudflare Turnstile captcha for a browser of your own, then report how the site answered.

Cost: 0.008 credits per solved token. A failed solve is free. An incorrect report refunds
      that solve once, within the workspace's report limits.

Run:
    pip install browsa
    BROWSA_API_KEY=agt_live_... python 05_solve_turnstile.py
    BROWSA_API_KEY=agt_live_... python 05_solve_turnstile.py --report incorrect
    BROWSA_API_KEY=agt_live_... python 05_solve_turnstile.py --url https://your.site/login --key 0x4AAAA...

The defaults are Browsa's own test page. Submit the token to the site, then report only
what the site itself answered: one report per task, within 15 minutes of the solve.
"""
import argparse

from browsa.captcha import CaptchaClient, CaptchaError, tasks

TEST_PAGE = "https://captcha-check.browsa.io/"
TEST_SITE_KEY = "0x4AAAAAAGEprtbosKnaIPao"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", default=TEST_PAGE)
    p.add_argument("--key", default=TEST_SITE_KEY)
    p.add_argument("--report", choices=["correct", "incorrect"], help="what the site answered for the token")
    args = p.parse_args()

    cap = CaptchaClient()  # reads BROWSA_API_KEY
    try:
        sol = cap.solve(tasks.turnstile(args.url, args.key))
    except CaptchaError as e:
        raise SystemExit(f"failed: {e.code}: {e}\nfix: {e.fix}\ncharged: {e.charged}")

    print("token:", sol["token"][:40] + "...")
    print("task:", sol.task_id, "| seconds:", sol.solve_seconds, "| cost:", sol.cost)

    if args.report:
        answer = cap.report(sol.task_id, correct=args.report == "correct")
        print("reported:", answer.get("outcome"), "| refunded:", answer.get("refunded"), "|", answer.get("refund"))
    else:
        print("Submit the token to the site, then run again with --report correct or --report incorrect.")


if __name__ == "__main__":
    main()
