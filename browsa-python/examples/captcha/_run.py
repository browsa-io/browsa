"""Shared by the examples in this folder: send one task to Browsa's captcha API and print the answer.

Standard library only, so every example runs with nothing installed:

    BROWSA_API_KEY=agt_live_... python ImageToTextTask.py captcha.png

Each example builds the `task` object for one type, with the names `GET https://captcha.browsa.io/types`
lists, once with only what is required (`basic`) and once with every parameter (`all_options`).
`solve` below is the whole protocol:

1. `POST /createTask` with `waitSeconds`: picture tasks are answered in this call, and a token task
   that ends within the wait is too.
2. Otherwise `POST /getTaskResult` with `waitSeconds`, again and again. The call is held until the
   task ends, so there is no sleep between calls and the answer arrives the moment it exists.
3. The answer says what the solve cost (`cost`) and how long it took (`solveSeconds`). A failed
   solve is free and says so.
4. If the site then refuses the solution, `report(task_id, correct=False)` gives the price back.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.environ.get("BROWSA_CAPTCHA_URL", "https://captcha.browsa.io").rstrip("/")
WAIT_SECONDS = 25          # the most the API holds one call
GIVE_UP_AFTER = 180        # seconds; a reCAPTCHA v2 picture puzzle can take two minutes


class CaptchaFailed(Exception):
    """The API answered errorId 1. `fix` says what to change, `charged` whether it cost anything."""

    def __init__(self, answer: dict):
        super().__init__(answer.get("errorDescription") or answer.get("errorCode"))
        self.code, self.fix, self.charged = answer.get("errorCode"), answer.get("fix"), answer.get("charged")
        self.answer = answer


def call(method: str, body: dict, api_key: str | None = None) -> dict:
    """POST /<method> with the key added. Returns the answer; raises CaptchaFailed on errorId 1."""
    key = api_key or os.environ.get("BROWSA_API_KEY")
    if not key:
        sys.exit("Set BROWSA_API_KEY to your Browsa API key.")
    req = urllib.request.Request(f"{BASE_URL}/{method}", method="POST",
                                 data=json.dumps({"clientKey": key, **body}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "browsa-captcha-example"})
    try:
        with urllib.request.urlopen(req, timeout=WAIT_SECONDS + 10) as resp:
            answer = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        answer = json.loads(e.read() or b"{}")
    if answer.get("errorId"):
        raise CaptchaFailed(answer)
    return answer


def solve(task: dict, api_key: str | None = None) -> dict:
    """Create the task and return its finished answer: {"taskId", "solution", "cost", "solveSeconds"}."""
    body = {"task": task, "waitSeconds": WAIT_SECONDS}
    answer = call("createTask", body, api_key)
    deadline = time.monotonic() + GIVE_UP_AFTER
    while answer.get("status") != "ready":
        if time.monotonic() > deadline:
            raise TimeoutError(f"task {answer.get('taskId')} did not finish in {GIVE_UP_AFTER} s")
        started = time.monotonic()
        answer = call("getTaskResult", {"taskId": answer["taskId"], "waitSeconds": WAIT_SECONDS}, api_key)
        if answer.get("status") != "ready" and time.monotonic() - started < 1:
            time.sleep(2)                        # a server that did not hold the call: poll politely
    return answer


def report(task_id: str, correct: bool, api_key: str | None = None) -> dict:
    """Tell the API whether the site took the solution. One report per task, within 15 minutes of the
    solve. Reports are recorded and used to improve solving."""
    return call("reportCorrect" if correct else "reportIncorrect", {"taskId": task_id}, api_key)


def b64file(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def cli(doc: str | None, needed: int) -> tuple[bool, list[str]]:
    """(the --all flag, the other arguments). Prints the example's own usage when arguments are missing."""
    args = [a for a in sys.argv[1:] if a != "--all"]
    if len(args) < needed or "-h" in args or "--help" in args:
        sys.exit((doc or "").strip())
    return "--all" in sys.argv[1:], args


def show(task: dict) -> None:
    """Solve `task` and print the answer the way a person wants to read it."""
    try:
        answer = solve(task)
    except CaptchaFailed as e:
        print(f"failed: {e.code}\n  {e}\n  charged: {e.charged}")
        sys.exit(1)
    cost = answer.get("cost") or {}
    print(json.dumps(answer.get("solution"), indent=2))
    print(f"task {answer.get('taskId')}: {answer.get('solveSeconds')} s, "
          f"{cost.get('amount')} {cost.get('unit')} ({cost.get('note')})")
    print("Tell the API how it went:  report(task_id, correct=True)  or  report(task_id, correct=False).")
