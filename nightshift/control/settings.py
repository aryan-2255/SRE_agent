import os
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.split(" #")[0].strip())


_load_env()


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


DATABASE_URL = env("DATABASE_URL", "postgresql://nightshift:nightshift@localhost:5433/nightshift")
REDIS_URL = env("REDIS_URL", "redis://localhost:6380/0")
TRUEFORGE_BASE_URL = env("TRUEFORGE_BASE_URL", "http://localhost:8790")
PROMETHEUS_URL = env("PROMETHEUS_URL", "http://localhost:9090")
OPS_MCP_URL = env("OPS_MCP_URL", "http://localhost:8000/mcp")
OPS_MCP_TOKEN = env("OPS_MCP_TOKEN")
DEMO_MODE = env("DEMO_MODE", "true").lower() == "true"
INCIDENT_BUDGET_USD = float(env("INCIDENT_BUDGET_USD", "5.0"))
STAGE_RUNNER = env("STAGE_RUNNER", "trueforge")  # or "fake"
SUPERVISOR = env("SUPERVISOR", "on").lower() != "off"  # AI chooses the next step within guardrails
USD_TO_INR = float(env("USD_TO_INR", "88"))

# USD per 1M tokens (input, output), used when the provider reports no cost (custom providers such as Bedrock).
# Kimi K3 from the Bedrock model card (global); MiniMax M2.5 from MiniMax's list price. Override with MODEL_PRICES.
MODEL_PRICES = {"kimi-k3": (3.00, 15.00), "minimax-m2-5": (0.30, 1.20)}
for item in filter(None, env("MODEL_PRICES").split(",")):   # e.g. kimi-k3=3:15,minimax-m2-5=0.3:1.2
    name, prices = item.split("=")
    MODEL_PRICES[name.strip()] = tuple(float(x) for x in prices.split(":"))


def estimate_cost(model_fqn: str, input_tokens: int, output_tokens: int) -> float:
    price = MODEL_PRICES.get(model_fqn.split("/")[-1])
    if not price:
        return 0.0
    return (input_tokens * price[0] + output_tokens * price[1]) / 1_000_000


@lru_cache
def system(name: str = "astronomy-shop") -> dict:
    return yaml.safe_load((ROOT / "systems" / f"{name}.yaml").read_text())
