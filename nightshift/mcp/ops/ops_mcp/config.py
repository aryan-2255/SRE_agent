import os
from functools import lru_cache
from pathlib import Path

import yaml


@lru_cache
def system() -> dict:
    """The onboarding file for the system this server operates."""
    path = Path(os.environ.get("SYSTEM_FILE", "/app/systems/astronomy-shop.yaml"))
    return yaml.safe_load(path.read_text())


def shop_path() -> Path:
    # Mounted at the same absolute path as on the host, so compose bind mounts resolve.
    return Path(os.environ["SHOP_PATH"])


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)
