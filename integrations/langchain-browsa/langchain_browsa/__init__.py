"""LangChain integration for Browsa (https://browsa.io): Phantom cloud browsers for AI agents."""

from importlib import metadata

from langchain_browsa.document_loaders import BrowsaLoader
from langchain_browsa.toolkits import BrowsaToolkit
from langchain_browsa.tools import (
    BrowsaExtractTool,
    BrowsaScrapeTool,
    BrowsaScreenshotTool,
    BrowsaTaskTool,
)

try:
    __version__ = metadata.version("langchain-browsa")
except metadata.PackageNotFoundError:  # running from a source checkout
    __version__ = ""

__all__ = [
    "BrowsaExtractTool",
    "BrowsaLoader",
    "BrowsaScrapeTool",
    "BrowsaScreenshotTool",
    "BrowsaTaskTool",
    "BrowsaToolkit",
    "__version__",
]
