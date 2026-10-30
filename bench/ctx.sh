#!/usr/bin/env bash
# Context overhead probe: one "Reply with exactly OK." per config; prints total context tokens and cost.
set -euo pipefail
cd "$(dirname "$0")"; W="${LEANREA_WORK:-$PWD/work}"; C="$W/ctx"; MODEL="${BENCH_MODEL:-sonnet}"
mkdir -p "$C/none" "$C/leanrea/.claude/skills" "$C/rea/.claude/skills"
cp -R ../leanrea "$C/leanrea/.claude/skills/"
cp -R "$W/rea-install/node_modules/rea-agents/skills/reverse-engineer-anything" "$C/rea/.claude/skills/"
probe() { local dir=$1 prompt=$2; shift 2
  (cd "$C/$dir" && echo "$prompt" | claude -p --model "$MODEL" --output-format json --strict-mcp-config --no-session-persistence "$@" \
    | jq -c '{cost: .total_cost_usd, ctx_tokens: (.usage.input_tokens + .usage.cache_creation_input_tokens + .usage.cache_read_input_tokens)}'); }
echo -n "nothing:                      "; probe none "Reply with exactly OK."
echo -n "leanrea skill invoked:        "; probe leanrea "/leanrea Reply with exactly OK."
echo -n "REA skill + MCP:              "; probe rea "/reverse-engineer-anything Reply with exactly OK." --mcp-config "$W/rea-mcp.json"
echo -n "REA MCP, tool search auto:    "; probe rea "Reply with exactly OK." --mcp-config "$W/rea-mcp.json"
echo -n "REA MCP, tool search OFF:     "; ENABLE_TOOL_SEARCH=false probe rea "Reply with exactly OK." --mcp-config "$W/rea-mcp.json"
