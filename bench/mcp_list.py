"""Dump an MCP server's tools/list and size it: python3 mcp_list.py node .../rea.mjs --mcp  (writes rea_tools.json)"""
import json, subprocess, sys, time
cmd = sys.argv[1:]
t0 = time.time()
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(o): p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
def recv(want):
    while True:
        l = p.stdout.readline()
        if not l: raise SystemExit("eof")
        m = json.loads(l)
        if m.get("id") == want: return m
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"b","version":"1"}}})
init = recv(1); t1 = time.time()
send({"jsonrpc":"2.0","method":"notifications/initialized"})
tools, cur, i = [], None, 2
while True:
    send({"jsonrpc":"2.0","id":i,"method":"tools/list","params":({"cursor":cur} if cur else {})})
    r = recv(i)["result"]; tools += r["tools"]; cur = r.get("nextCursor"); i += 1
    if not cur: break
t2 = time.time(); p.kill()
instr = init["result"].get("instructions") or ""
blob = json.dumps(tools)
json.dump({"tools": tools, "instructions": instr}, open("rea_tools.json", "w"))
print(f"tools={len(tools)} defs_bytes={len(blob)} input_schema_bytes={len(json.dumps([t.get('inputSchema') for t in tools]))} output_schema_bytes={len(json.dumps([t.get('outputSchema') for t in tools if t.get('outputSchema')]))} desc_bytes={sum(len(t.get('description','')) for t in tools)} instructions_bytes={len(instr)} startup_s={t1-t0:.2f} list_s={t2-t1:.2f}")
