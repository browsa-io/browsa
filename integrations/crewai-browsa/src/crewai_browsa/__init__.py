"""CrewAI tools for Browsa, cloud browsers for AI agents (https://browsa.io).

from crewai import Agent
from crewai_browsa import BrowsaTaskTool, BrowsaScrapeTool

agent = Agent(
    role="Web researcher",
    goal="Find facts on live websites",
    backstory="Uses a Phantom cloud browser.",
    tools=[BrowsaTaskTool(), BrowsaScrapeTool()],  # reads BROWSA_API_KEY
)
"""

from ._common import BrowsaBaseTool
from ._version import __version__
from .tools import (
    BrowsaExtractTool,
    BrowsaExtractToolSchema,
    BrowsaScrapeTool,
    BrowsaScrapeToolSchema,
    BrowsaScreenshotTool,
    BrowsaScreenshotToolSchema,
    BrowsaTaskTool,
    BrowsaTaskToolSchema,
)

__all__ = [
    "BrowsaBaseTool",
    "BrowsaExtractTool",
    "BrowsaExtractToolSchema",
    "BrowsaScrapeTool",
    "BrowsaScrapeToolSchema",
    "BrowsaScreenshotTool",
    "BrowsaScreenshotToolSchema",
    "BrowsaTaskTool",
    "BrowsaTaskToolSchema",
    "__version__",
]
