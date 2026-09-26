"""Runtime adapter for Docker Compose: deploy, rollback, restart, scale, canary.

Every deployed image is tagged nightshift/<service>:<shortsha>, so rollback is a retag
and a container swap with no rebuild.
"""
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


class ComposeError(RuntimeError):
    pass


def _run(cmd: list[str], cwd: Path | None = None, timeout: int = 900) -> str:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise ComposeError(f"{' '.join(cmd[:4])}… failed: {(p.stderr or p.stdout).strip()[-800:]}")
    return p.stdout.strip()


class DockerComposeRuntime:
    def __init__(self, shop: Path, runtime: dict, image_prefix: str = "ghcr.io/open-telemetry/demo:latest-"):
        self.shop = shop
        self.project = runtime["project"]
        self.env_files = runtime.get("env_files", [])
        self.files = runtime["compose_files"]
        self.image_prefix = image_prefix
        self.state_dir = shop / ".nightshift"
        self.state_dir.mkdir(exist_ok=True)
        self.history_file = self.state_dir / "deploys.json"

    # ---------- helpers ----------
    def compose(self, *args: str, timeout: int = 900) -> str:
        cmd = ["docker", "compose", "-p", self.project]
        for f in self.env_files:
            cmd += ["--env-file", f]
        for f in self.files:
            cmd += ["-f", f]
        return _run(cmd + list(args), cwd=self.shop, timeout=timeout)

    def git(self, *args: str) -> str:
        # the shop may be its own repo or a folder inside a larger repo; git finds the repo from here
        return _run(["git", "-c", "safe.directory=*", *args], cwd=self.shop, timeout=120)

    def history(self) -> list[dict]:
        if not self.history_file.exists():
            return []
        return json.loads(self.history_file.read_text())

    def _record(self, entry: dict) -> None:
        h = self.history()
        h.append({"time": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry})
        self.history_file.write_text(json.dumps(h[-200:], indent=1))

    def compose_image(self, service: str) -> str:
        return f"{self.image_prefix}{service}"

    def _ensure_baseline(self, service: str) -> None:
        """Remember the image the shop started with, so there is always something to roll back to."""
        tags = _run(["docker", "images", "-q", f"nightshift/{service}:baseline"])
        if not tags:
            _run(["docker", "tag", self.compose_image(service), f"nightshift/{service}:baseline"])

    def _swap_in(self, service: str, image_tag: str) -> None:
        _run(["docker", "tag", image_tag, self.compose_image(service)])
        self.compose("up", "-d", "--no-deps", "--force-recreate", service, timeout=300)

    def wait_healthy(self, container: str, seconds: int = 90) -> str:
        deadline = time.time() + seconds
        state = "unknown"
        while time.time() < deadline:
            fmt = "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}"
            state = _run(["docker", "inspect", "-f", fmt, container])
            if state in ("healthy", "running") and time.time() > deadline - seconds + 3:
                return state
            time.sleep(2)
        return state

    def running_commit(self, service: str) -> str:
        for entry in reversed(self.history()):
            if entry["service"] == service and entry["action"] in ("deploy", "rollback", "promote_canary", "demo", "reset"):
                return entry["commit"]
        return "baseline"

    # ---------- read ----------
    def services(self) -> list[dict]:
        out = self.compose("ps", "--format", "json")
        rows = [json.loads(line) for line in out.splitlines() if line.strip().startswith("{")]
        return [
            {
                "service": r.get("Service"),
                "state": r.get("State"),
                "health": r.get("Health") or "",
                "status": r.get("Status"),
                "running_commit": self.running_commit(r.get("Service", "")),
            }
            for r in sorted(rows, key=lambda r: r.get("Service", ""))
        ]

    def recent_deploys(self, service: str = "", limit: int = 10) -> list[dict]:
        h = [e for e in self.history() if not service or e["service"] == service]
        return h[-limit:]

    def recent_commits(self, path: str, limit: int = 10) -> list[dict]:
        out = self.git("log", f"-{limit}", "--date=iso-strict", "--pretty=format:%h%x1f%ad%x1f%an%x1f%s", "--", path)
        return [dict(zip(("commit", "date", "author", "message"), line.split("\x1f"))) for line in out.splitlines() if line]

    # ---------- change ----------
    def deploy(self, service: str, path: str, commit: str = "origin/main") -> dict:
        if self.git("status", "--porcelain", "--untracked-files=no", "--", ".", ":!src/flagd/demo.flagd.json"):
            raise ComposeError("The shop folder has uncommitted changes. Commit or stash them before deploying.")
        self._ensure_baseline(service)
        self.git("fetch", "--quiet", "origin")
        self.git("merge", "--ff-only", commit)
        sha = self.git("rev-parse", "--short", "HEAD")
        tag = f"nightshift/{service}:{sha}"
        if not _run(["docker", "images", "-q", tag]):
            self.compose("build", service, timeout=1200)
            _run(["docker", "tag", self.compose_image(service), tag])
        self._swap_in(service, tag)
        health = self.wait_healthy(service)
        self._record({"action": "deploy", "service": service, "commit": sha, "image": tag})
        return {"service": service, "commit": sha, "image": tag, "health": health,
                "changed_files": self.git("show", "--stat", "--oneline", sha, "--", path)[:1500]}

    def rollback(self, service: str, to_commit: str = "") -> dict:
        self._ensure_baseline(service)
        current = self.running_commit(service)
        if not to_commit:
            prior = [e["commit"] for e in self.history() if e["service"] == service and e["commit"] != current]
            to_commit = prior[-1] if prior else "baseline"
        tag = f"nightshift/{service}:{to_commit}"
        if not _run(["docker", "images", "-q", tag]):
            raise ComposeError(f"No image {tag} to roll back to. Known: {self.known_images(service)}")
        started = time.time()
        self._swap_in(service, tag)
        health = self.wait_healthy(service)
        self._record({"action": "rollback", "service": service, "commit": to_commit, "from": current, "image": tag})
        return {"service": service, "from": current, "to": to_commit, "health": health,
                "seconds": round(time.time() - started, 1)}

    def known_images(self, service: str) -> list[str]:
        out = _run(["docker", "images", f"nightshift/{service}", "--format", "{{.Tag}}"])
        return out.splitlines()

    def mark(self, service: str, commit: str, image: str, action: str = "demo") -> None:
        """Used by the chaos scripts to record a demo deploy so rollback knows what is running."""
        self._record({"action": action, "service": service, "commit": commit, "image": image})

    def restart(self, service: str) -> dict:
        self.compose("restart", service, timeout=180)
        return {"service": service, "health": self.wait_healthy(service)}

    def scale(self, service: str, replicas: int) -> dict:
        replicas = max(1, min(int(replicas), 5))
        self.compose("up", "-d", "--no-deps", "--no-recreate", "--scale", f"{service}={replicas}", service, timeout=300)
        return {"service": service, "replicas": replicas}

    # ---------- canary (payment-lb splits gRPC traffic by weight) ----------
    def _lb_conf(self, canary_weight: int) -> str:
        main = 100 - canary_weight
        canary = f"    server payment-canary:50051 weight={canary_weight};\n" if canary_weight else ""
        return (
            "upstream payment_backends {\n"
            f"    server payment:50051 weight={main};\n{canary}"
            "}\n"
        )

    def _set_weights(self, canary_weight: int) -> None:
        conf = self.state_dir / "payment-lb" / "upstream.conf"
        conf.parent.mkdir(exist_ok=True)
        conf.write_text(self._lb_conf(canary_weight))
        _run(["docker", "exec", "payment-lb", "nginx", "-s", "reload"])

    def deploy_canary(self, service: str, commit: str, percent: int = 10) -> dict:
        if service != "payment":
            raise ComposeError("Canary is wired for payment only (payment-lb).")
        tag = f"nightshift/{service}:{commit}"
        if not _run(["docker", "images", "-q", tag]):
            # Build the merged commit's image without touching the running service.
            if self.git("status", "--porcelain", "--untracked-files=no", "--", ".", ":!src/flagd/demo.flagd.json"):
                raise ComposeError("The shop folder has uncommitted changes. Commit or stash them before deploying.")
            self._ensure_baseline(service)
            self.git("fetch", "--quiet", "origin")
            head = self.git("rev-parse", "--short", "HEAD")
            try:
                self.git("merge", "--ff-only", commit)
            except ComposeError:
                raise ComposeError(f"Cannot move main to {commit}: it is not ahead of main ({head}). After a merged PR, "
                                   f"pass the merge commit sha from merge_pull_request, not the PR's head commit.") from None
            commit = self.git("rev-parse", "--short", "HEAD")
            tag = f"nightshift/{service}:{commit}"
            if not _run(["docker", "images", "-q", tag]):
                live = _run(["docker", "inspect", "-f", "{{.Image}}", service])
                self.compose("build", service, timeout=1200)
                _run(["docker", "tag", self.compose_image(service), tag])
                _run(["docker", "tag", live, self.compose_image(service)])  # the live service keeps its image
        env = _run(["docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", service]).splitlines()
        _run(["docker", "rm", "-f", "payment-canary"]) if _run(["docker", "ps", "-aq", "-f", "name=^payment-canary$"]) else None
        cmd = ["docker", "run", "-d", "--name", "payment-canary", "--network", "opentelemetry-demo",
               "--label", "nightshift.canary=true"]
        for e in env:
            if e.startswith("OTEL_SERVICE_NAME="):
                continue
            if e:
                cmd += ["-e", e]
        cmd += ["-e", "OTEL_SERVICE_NAME=payment", "-e", "OTEL_RESOURCE_ATTRIBUTES=service.instance.id=payment-canary,deployment.canary=true", tag]
        _run(cmd)
        time.sleep(3)
        self._set_weights(max(1, min(int(percent), 50)))
        self._record({"action": "deploy_canary", "service": service, "commit": commit, "percent": percent, "image": tag})
        return {"service": service, "canary_commit": commit, "percent": percent}

    def promote_canary(self, service: str) -> dict:
        entry = next((e for e in reversed(self.history()) if e["action"] == "deploy_canary" and e["service"] == service), None)
        if not entry:
            raise ComposeError("No canary to promote.")
        self._swap_in(service, entry["image"])
        self.wait_healthy(service)
        self._set_weights(0)
        _run(["docker", "rm", "-f", "payment-canary"])
        self._record({"action": "promote_canary", "service": service, "commit": entry["commit"], "image": entry["image"]})
        return {"service": service, "promoted": entry["commit"]}

    def abort_canary(self, service: str) -> dict:
        self._set_weights(0)
        if _run(["docker", "ps", "-aq", "-f", "name=^payment-canary$"]):
            _run(["docker", "rm", "-f", "payment-canary"])
        self._record({"action": "abort_canary", "service": service, "commit": self.running_commit(service)})
        return {"service": service, "canary": "removed"}
