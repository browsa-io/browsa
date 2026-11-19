"""Browsa's captcha-solving API, in the createTask / getTaskResult / getBalance format that
CapSolver, Anti-Captcha, CapMonster and 2Captcha's v2 API share. Same key and credits as the
browser API.

    from browsa.captcha import CaptchaClient, tasks

    cap = CaptchaClient()   # BROWSA_API_KEY
    sol = cap.solve(tasks.recaptcha_v3("https://example.com/login", "6Lc...", page_action="login"))
    token = sol["gRecaptchaResponse"]

Coming from another service: ``browsa.captcha.compat`` (2Captcha and Anti-Captcha libraries).
Measured pass rates per type: https://browsa.io/captcha
"""
from . import compat, tasks
from ._client import (
    DEFAULT_CAPTCHA_URL,
    AsyncCaptchaClient,
    CaptchaClient,
    CaptchaError,
    CaptchaTimeoutError,
    Solution,
)
from .tasks import TASK_TYPES, normalize_task

__all__ = [
    "CaptchaClient", "AsyncCaptchaClient", "CaptchaError", "CaptchaTimeoutError", "Solution",
    "DEFAULT_CAPTCHA_URL", "TASK_TYPES", "normalize_task", "tasks", "compat",
]
