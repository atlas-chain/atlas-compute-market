#!/usr/bin/env python3
"""Host-side manager for the network-less Atlas provider container.

Spawns the atlas-agent docker image with `--network none` and hard CPU/RAM
limits, then relays the agent's registry traffic as files: the container
writes `req-*.json` into a shared exchange directory, this manager forwards
each one to the registry over HTTPS and writes the answer back as
`resp-*.json` (see agent/src/file_transport.rs for the file protocol).
The container never touches the network; everything it needs is baked into
the image. The provider key is generated inside the container on first run
and persists in the state directory (provider.key).

Usage:
  python3 agent/manager.py --cpus 4 --memory-gib 8
  python3 agent/manager.py --base-url http://localhost:8080 --once

Requires only python3 and docker.
"""

import argparse
import json
import math
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://compute-market.arkiv-global.net"
POLL_SEC = 0.01  # relay latency adds to server-timed benchmark lanes; keep small
HTTP_TIMEOUT_SEC = 120


def parse_args():
    p = argparse.ArgumentParser(
        description="Spawn the offline atlas-agent container and relay its registry traffic.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--base-url", default=DEFAULT_BASE_URL, help="registry URL the relay forwards to")
    p.add_argument("--cpus", type=float, default=float(os.cpu_count() or 1),
                   help="docker --cpus limit; also sets the declared CORE_COUNT (floor)")
    p.add_argument("--memory-gib", type=int, default=4,
                   help="docker --memory limit in GiB; also sets the declared RAM_GIB")
    p.add_argument("--image", default="atlas-agent", help="docker image to run")
    p.add_argument("--build", action="store_true", help="rebuild the image even if it exists")
    p.add_argument("--name", default="atlas-provider", help="container name")
    p.add_argument("--state-dir", default=os.path.expanduser("~/.atlas-provider"),
                   help="host dir for the exchange files and the persistent provider key")
    p.add_argument("--price", default="0.05", help="MIN_PRICE_PER_HOUR (GLM)")
    p.add_argument("--display-name", default=None, help="provider display name")
    p.add_argument("--heartbeat-sec", type=int, default=60, help="heartbeat interval (15-900)")
    p.add_argument("--once", action="store_true", help="full flow, one heartbeat, exit")
    p.add_argument("--force-bench", action="store_true",
                   help="re-run the benchmark even when a live attestation exists")
    return p.parse_args()


def image_exists(image):
    return subprocess.run(["docker", "image", "inspect", image],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def build_image(image):
    agent_dir = pathlib.Path(__file__).resolve().parent
    print(f"[manager] building image {image} from {agent_dir} …")
    subprocess.run(["docker", "build", "-t", image, str(agent_dir)], check=True)


def host_cpu_model():
    if platform.system() != "Linux":
        return None
    try:
        for line in pathlib.Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()[:128] or None
    except OSError:
        pass
    return None


def forward(base_url, req):
    """One registry round-trip for a container request file (§8 endpoints only)."""
    path = req.get("path", "")
    method = req.get("method", "POST")
    if not path.startswith("/v1/") or method not in ("GET", "POST"):
        return {"status": 0, "error": f"relay refused {method} {path!r}: only GET/POST /v1/* is allowed"}
    url = base_url.rstrip("/") + path
    data = None
    headers = {"accept": "application/json"}
    if method == "POST":
        data = json.dumps(req.get("body")).encode()
        headers["content-type"] = "application/json"
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=data, headers=headers, method=method),
            timeout=HTTP_TIMEOUT_SEC,
        ) as resp:
            return {"status": resp.status, "body": json.load(resp)}
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except Exception:
            body = {"error": {"code": "UNKNOWN", "message": f"non-JSON {e.code} response"}}
        return {"status": e.code, "body": body}
    except Exception as e:
        return {"status": 0, "error": str(e)}


def write_atomic(path, obj):
    tmp = path.with_name("." + path.name + ".tmp")
    tmp.write_text(json.dumps(obj))
    tmp.rename(path)


def relay_pending(state_dir, base_url):
    handled = 0
    for req_path in sorted(state_dir.glob("req-*.json")):
        try:
            req = json.loads(req_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue  # written via rename, so this should not happen; skip and retry
        resp = forward(base_url, req)
        status = resp.get("status")
        note = "" if status else f" ({resp.get('error')})"
        print(f"[relay] {req.get('method')} {req.get('path')} → {status or 'transport error'}{note}")
        write_atomic(state_dir / f"resp-{req['id']}.json", resp)
        req_path.unlink(missing_ok=True)
        handled += 1
    return handled


def main():
    args = parse_args()
    if shutil.which("docker") is None:
        sys.exit("docker not found on PATH")
    if args.cpus <= 0 or args.memory_gib <= 0:
        sys.exit("--cpus and --memory-gib must be positive")

    state_dir = pathlib.Path(args.state_dir).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    for stale in list(state_dir.glob("req-*.json")) + list(state_dir.glob("resp-*.json")) \
            + list(state_dir.glob(".*.tmp")):
        stale.unlink(missing_ok=True)

    if args.build or not image_exists(args.image):
        build_image(args.image)

    core_count = max(1, math.floor(args.cpus))
    env = {
        "CORE_COUNT": str(core_count),
        "RAM_GIB": str(args.memory_gib),
        "MIN_PRICE_PER_HOUR": args.price,
        "HEARTBEAT_SEC": str(args.heartbeat_sec),
    }
    cpu_model = host_cpu_model()
    if cpu_model:
        env["CPU_MODEL"] = cpu_model
    if args.display_name:
        env["DISPLAY_NAME"] = args.display_name

    # a leftover container from a previous run would collide on the name
    subprocess.run(["docker", "rm", "-f", args.name],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    cmd = ["docker", "run", "--rm", "--name", args.name,
           "--network", "none",
           "--cpus", str(args.cpus),
           "--memory", f"{args.memory_gib}g", "--memory-swap", f"{args.memory_gib}g",
           "--user", f"{os.getuid()}:{os.getgid()}",
           "-v", f"{state_dir}:/exchange"]
    for k, v in env.items():
        cmd += ["-e", f"{k}={v}"]
    cmd += [args.image, "--exchange", "/exchange"]
    if args.once:
        cmd.append("--once")
    if args.force_bench:
        cmd.append("--force-bench")

    print(f"[manager] registry: {args.base_url}")
    print(f"[manager] limits: --cpus {args.cpus} --memory {args.memory_gib}g (declaring {core_count} cores)")
    print(f"[manager] state: {state_dir}")
    proc = subprocess.Popen(cmd)
    try:
        while proc.poll() is None:
            if relay_pending(state_dir, args.base_url) == 0:
                time.sleep(POLL_SEC)
    except KeyboardInterrupt:
        print("\n[manager] stopping container …")
        subprocess.run(["docker", "stop", "-t", "5", args.name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        code = proc.wait()
    sys.exit(code)


if __name__ == "__main__":
    main()
