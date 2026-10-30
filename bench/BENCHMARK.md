# REA vs a lean skill: benchmark (2026-10-16)

Setup: Claude Code 2.1.301 headless (`claude -p`), Sonnet 5.5, macOS arm64. REA is rea-agents@6.5.0 (207 MCP tools, run as `rea --mcp`) plus its own skill (`/reverse-engineer-anything`). Every run starts in a fresh copy of the targets. Answers were graded by regex against answer keys I made by hand.

Arms:
- **none**: no skill, no MCP.
- **leanrea** (shown as `lean` in `results/final.jsonl`): `/leanrea`, the 8 KB `leanrea/SKILL.md`, no MCP.
- **rea**: REA MCP plus the REA skill.

Tasks (3 reps per arm per task, 36 runs, arms run side by side):
- **electron**: Notion app.asar. Trace mic/meeting detection: native fn, class, IPC channels.
- **native**: mac_utils.node. Exports, the TCC check, the single-instance lock.
- **go**: `gh`. Toolchain version, main path, two dependency versions.
- **deep**: mac_utils.node, from the disassembly. Socket path format, wire protocol, peer authentication.

## Results (median wall time; means for turns, cost, tokens)

| task | arm | wall s | turns | cost $ | tokens k | score |
|---|---|---|---|---|---|---|
| electron | leanrea | **35.3** | **4.7** | **0.171** | **196** | 14/15 |
| electron | none | 52.8 | 9.7 | 0.173 | 342 | 15/15 |
| electron | rea | 82.9 | 13.3 | 0.341 | 725 | 15/15 |
| native | leanrea | 43.4 | **5.3** | 0.201 | **239** | 24/24 |
| native | none | **36.7** | 6.7 | **0.173** | 245 | 24/24 |
| native | rea | 46.0 | 11.3 | 0.268 | 511 | 24/24 |
| go | leanrea | **12.4** | 2.3 | 0.110 | 87 | 12/12 |
| go | none | 13.8 | **2.0** | **0.092** | **67** | 12/12* |
| go | rea | 25.9 | 6.0 | 0.171 | 233 | 12/12 |
| deep | leanrea | **38.6** | **6.0** | **0.241** | **278** | 24/24 |
| deep | none | 45.3 | 8.7 | 0.298 | 383 | 16/24 (1 refusal) |
| deep | rea | 45.7 | 10.7 | 0.339 | 509 | 24/24 |

Totals over 12 runs per arm:

| arm | wall | cost | turns | tokens | score |
|---|---|---|---|---|---|
| **leanrea** | **388 s** | **$2.17** | **55** | **2.40 M** | 74/75 |
| none | 479 s | $2.21 | 81 | 3.11 M | 67/75 |
| rea | 627 s | $3.36 | 124 | 5.93 M | 75/75 |

\* One "none/go" answer wrote "Go 1.27.1" and the regex wanted "go1.27.1". That is a grader false negative, corrected above.

The lean skill against REA:
- 38% less wall time.
- 35% lower cost.
- 56% fewer turns.
- 60% fewer tokens.
- Same accuracy. The lean skill's only miss: one run named the v1 change channel instead of the v2 one. Both channels exist.

The lean skill against no skill:
- 19% faster, with 32% fewer turns and 23% fewer tokens.
- Cost is the same.
- It avoided the one refusal the bare model gave on the deep task.

## Context overhead ("Reply with exactly OK")

| config | context tokens | cost |
|---|---|---|
| nothing | 31.4k | $0.08 |
| lean skill invoked | 34.5k (+3.1k) | $0.09 |
| REA MCP, deferred tool search (CC default) | 34.9k (+3.5k) | $0.09 |
| REA skill invoked + MCP | 42.7k (+11.3k) | $0.13 |
| **REA MCP, tool search off (all tools loaded)** | **400.7k (+369k)** | **$1.60** |

REA's raw `tools/list`: 207 tools, 3.35 MB JSON (745 KB input schemas, 2.46 MB output schemas, 90 KB descriptions).

## Tool-level microbenchmark (same operation, same file)

| operation | REA CLI | raw command |
|---|---|---|
| Go build info, `gh` | 0.56 s, 62.5 KB | `go version -m`: 0.06 s, 15.6 KB |
| Mach-O overview, mac_utils.node | 3.32 s, 52.8 KB | otool/dyld_info/nm: 0.04 s, 28.3 KB |
| Electron app analysis, Notion | fails `artifact_integrity_mismatch` unless you add `--integrity-policy record-and-continue`; then **47.9 s, 140 MB** | asar extract + `rg -uu` IPC sweep: 4.8 s, 24 KB |

## Caveats
- n=3 per cell, one model (Sonnet), one machine, three targets. The REA arm used Claude Code's deferred tool search, which is REA's best case. Agents that load every tool pay the 369k-token row above.
- Native providers (Ghidra, Hopper, IDA) are not installed, so REA used its built-in native path. The lean arm used otool.

Reproduce: `./setup.sh`, then `./run_all.sh` (or `python3 -I run.py <none|leanrea|rea> <task> <rep>`) and `./ctx.sh`.
