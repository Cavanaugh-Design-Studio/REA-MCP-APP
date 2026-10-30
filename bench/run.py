"""Run one benchmark cell: python3 -I run.py <arm> <task_id> <rep>. Arms: rea | leanrea | none.
Needs ./setup.sh first. Work dir: $LEANREA_WORK (default ./work)."""
import json, os, re, shutil, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
B = os.path.abspath(os.environ.get("LEANREA_WORK", os.path.join(HERE, "work")))
ARM, TID, REP = sys.argv[1], sys.argv[2], sys.argv[3]
MODEL = os.environ.get("BENCH_MODEL", "sonnet")
task = next(t for t in json.load(open(f"{HERE}/tasks.json")) if t["id"] == TID)
ws = f"{B}/runs/{ARM}-{TID}-{REP}"
shutil.rmtree(ws, ignore_errors=True); os.makedirs(ws)
for f in ["app.asar", "mac_utils.node", "gh"]:
    subprocess.run(["cp", "-c", f"{B}/targets/{f}", ws], check=True)
subprocess.run(["cp", "-cR", f"{B}/targets/app.asar.unpacked", ws], check=True)
cmd = ["claude", "-p", "--model", MODEL, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
       "--no-session-persistence", "--max-budget-usd", "4",
       "--allowedTools", "Bash,Read,Grep,Glob,Write,Skill,mcp__rea"]
prompt = task["prompt"]
skills = os.path.join(ws, ".claude", "skills")
if ARM == "rea":
    shutil.copytree(f"{B}/rea-install/node_modules/rea-agents/skills/reverse-engineer-anything", f"{skills}/reverse-engineer-anything")
    cmd += ["--mcp-config", f"{B}/rea-mcp.json"]
    prompt = "/reverse-engineer-anything " + prompt
elif ARM == "leanrea":
    shutil.copytree(f"{REPO}/leanrea", f"{skills}/leanrea")
    prompt = "/leanrea " + prompt
t0 = time.time()
p = subprocess.run(cmd, input=prompt, cwd=ws, capture_output=True, text=True, timeout=1500)
wall = time.time() - t0
r, tools = {"result": p.stdout[-2000:] + p.stderr[-2000:], "is_error": True}, []
for line in p.stdout.splitlines():
    try:
        ev = json.loads(line)
    except Exception:
        continue
    if ev.get("type") == "result":
        r = ev
    if ev.get("type") == "assistant":
        for c in ev["message"].get("content", []):
            if c.get("type") == "tool_use":
                n = c["name"]
                tools.append(n if n != "Bash" else "Bash:" + c["input"].get("command", "")[:60].split()[0] if c["input"].get("command") else n)
ans = r.get("result") or ""
hits = {k: bool(re.search(v, ans, re.I)) for k, v in task["key"].items()}
u = r.get("usage", {})
row = {"arm": ARM, "task": TID, "rep": REP, "wall_s": round(wall, 1), "turns": r.get("num_turns"),
       "cost": r.get("total_cost_usd"), "in": u.get("input_tokens", 0), "cache_w": u.get("cache_creation_input_tokens", 0),
       "cache_r": u.get("cache_read_input_tokens", 0), "out": u.get("output_tokens", 0),
       "score": f"{sum(hits.values())}/{len(hits)}", "miss": [k for k, v in hits.items() if not v], "err": r.get("is_error"), "tools": tools}
json.dump({**row, "answer": ans}, open(f"{ws}.json", "w"), indent=1)
print(json.dumps(row))
