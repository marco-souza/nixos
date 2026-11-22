#!/usr/bin/env python3
"""Keep factory jobs in step with their pull requests.

For every job whose PR is open (stage pr, team-review or merge-ready) this asks
GitHub for the PR's reviews and moves the job:

  team-review              -> merge-ready   enough teammates approved
  team-review, merge-ready -> pr            a teammate asked for changes
  merge-ready              -> team-review   an approval was withdrawn or dismissed
  any of the three         -> merged        the PR was merged

It only reads the PR and rewrites job.json. It never merges, approves, comments
or requests reviewers: merging is the human's.

  sync.py                  one pass
  sync.py --watch [SEC]    a pass every SEC seconds (default 60)
  sync.py --serve [PORT]   serve the dashboard on localhost:PORT (default 8000) and watch

Run it from the repo (it looks for ./.factory/jobs, then ./jobs), or pass --dir.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

NEED = 2  # teammate approvals before a job goes back to the human to merge
OPEN_PR_STAGES = ("pr", "team-review", "merge-ready")
TEAMMATE = {"MEMBER", "OWNER", "COLLABORATOR"}  # people who can approve for real
OPINION = {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


def pr_state(url):
    out = subprocess.run(
        ["gh", "pr", "view", url, "--json", "state,author,reviews"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode:
        lines = out.stderr.strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "gh pr view failed")
    return json.loads(out.stdout)


def reviews(pr):
    """Teammates whose latest opinion approves, and those whose latest asks for changes.

    A later comment doesn't undo an approval; a dismissal does. The PR's author
    and bots never count.
    """
    author = (pr.get("author") or {}).get("login")
    latest = {}
    for r in sorted(pr.get("reviews") or [], key=lambda r: r.get("submittedAt") or ""):
        who = r.get("author") or {}
        login = who.get("login")
        if not login or login == author or who.get("is_bot") or login.endswith("[bot]"):
            continue
        assoc = r.get("authorAssociation")
        if assoc and assoc not in TEAMMATE:
            continue
        if r.get("state") in OPINION:
            latest[login] = r["state"]
    by = sorted(who for who, state in latest.items() if state == "APPROVED")
    changes = sorted(who for who, state in latest.items() if state == "CHANGES_REQUESTED")
    return by, changes


def step(stage, state, by, changes, need):
    """The stage a job should be in, given its PR."""
    if state == "MERGED":
        return "merged"
    if state != "OPEN":
        return stage  # closed without a merge: the human decides what that means
    if stage == "team-review":
        return "pr" if changes else "merge-ready" if len(by) >= need else stage
    if stage == "merge-ready":
        return "pr" if changes else stage if len(by) >= need else "team-review"
    return stage


def sync_job(path):
    """Bring one job up to date. Returns a line saying what changed, or None."""
    text = path.read_text()
    job = json.loads(text)
    stage = job.get("stage")
    if stage not in OPEN_PR_STAGES or not job.get("pr"):
        return None

    pr = pr_state(job["pr"])
    by, changes = reviews(pr)
    had = job.get("approvals") or {}
    need = had.get("need", NEED)
    new = step(stage, pr.get("state"), by, changes, need)
    approvals = {"need": need, "by": by, "changes": changes}
    if new == stage and had == approvals:
        return None
    # An orchestrator may have rewritten the job while we asked GitHub. Leave it for the next pass.
    if path.read_text() != text:
        return None

    since = path.stat().st_mtime
    job["stage"], job["approvals"] = new, approvals
    tmp = path.with_name("job.json.tmp")
    tmp.write_text(json.dumps(job, indent=1) + "\n")
    os.replace(tmp, path)

    names = ", ".join(by) or "nobody yet"
    if new != stage:
        why = {
            "merged": "the PR was merged",
            "merge-ready": f"approved by {names}: ready for the human to merge",
            "pr": f"{', '.join(changes)} asked for changes",
            "team-review": f"approvals dropped to {len(by)} of {need}",
        }[new]
        return f"{stage} → {new}: {why}"
    # Same stage: keep the file's time, which the dashboard shows as "in this stage since".
    os.utime(path, (since, since))
    if changes and changes != (had.get("changes") or []):
        return f"{', '.join(changes)} asked for changes"
    if by != (had.get("by") or []):
        return f"approvals {len(by)} of {need}: {names}"
    return None


def one_pass(base):
    for path in sorted((base / "jobs").glob("*/job.json")):
        job_id = path.parent.name
        try:
            line = sync_job(path)
        except FileNotFoundError as err:
            if err.filename == "gh":
                sys.exit("sync: the gh CLI is not installed or not on PATH.")
            raise
        except Exception as err:  # one bad job or a network blip must not stop the rest
            print(f"sync: {job_id}: {err}", file=sys.stderr, flush=True)
            continue
        if line:
            stamp = time.strftime("%H:%M:%S")
            print(f"{stamp} {job_id}: {line}", flush=True)
            with open(path.parent / "activity.log", "a") as log:
                log.write(f"{stamp} sync {line}\n")


class Board(ThreadingHTTPServer):
    request_queue_size = 64  # the dashboard asks for many small files at once


class Quiet(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep connections open between the dashboard's polls

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(base, port):
    try:
        server = Board(("127.0.0.1", port), partial(Quiet, directory=str(base)))
    except OSError as err:
        sys.exit(f"sync: can't serve on port {port} ({err.strerror}). "
                 f"If the dashboard is already being served there, run `sync.py --watch` beside it.")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"dashboard: http://localhost:{port}/dashboard.html", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Keep factory jobs in step with their pull requests.")
    ap.add_argument("--watch", nargs="?", type=int, const=60, metavar="SEC", help="a pass every SEC seconds (default 60)")
    ap.add_argument("--serve", nargs="?", type=int, const=8000, metavar="PORT", help="also serve the dashboard on localhost:PORT (default 8000)")
    ap.add_argument("--dir", metavar="FACTORY", help="the factory folder (default: ./.factory, then .)")
    args = ap.parse_args()

    candidates = [Path(args.dir)] if args.dir else [Path.cwd() / ".factory", Path.cwd()]
    base = next((d for d in candidates if (d / "jobs").is_dir()), None)
    if base is None:
        sys.exit("sync: no .factory/jobs folder here. Run it from the repo, or pass --dir <repo>/.factory.")

    if args.serve is not None:
        serve(base, args.serve)
    every = args.watch if args.watch is not None else 60 if args.serve is not None else None
    try:
        one_pass(base)
        while every:
            time.sleep(max(every, 10))
            one_pass(base)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
