# Changelog

Published on PyPI: **0.1.0** (`pip index versions crewai-browsa`). 0.1.1 below is in this repository and not on PyPI yet.

## 0.1.1 (unreleased: not on PyPI)

- Packaging only: the licence is declared in the form PyPI's `license` field reads (`license = {text = "MIT"}` and the `License :: OSI Approved :: MIT License` classifier), so the project page and the JSON API show MIT. 0.1.0 declared it as an SPDX expression only, which left that field empty. The code is the same as 0.1.0.
- Source and Changelog links in the project metadata.
- Calls send `crewai-browsa/<version>` after the SDK's own User-Agent (with a `browsa` SDK that has `user_agent_suffix`; an older one gets the plain call).

## 0.1.0 (2026-11-16)

First version: `BrowsaTaskTool`, `BrowsaScrapeTool`, `BrowsaExtractTool` and `BrowsaScreenshotTool`.
