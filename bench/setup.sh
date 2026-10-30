#!/usr/bin/env bash
# Prepares bench/work: installs rea-agents@6.5.0 and copies the three targets.
# Targets (macOS): Notion.app's app.asar + mac_utils.node, and Homebrew's gh.
set -euo pipefail
cd "$(dirname "$0")"
W="${LEANREA_WORK:-$PWD/work}"; mkdir -p "$W/targets" "$W/rea-install"
NOTION=/Applications/Notion.app/Contents/Resources
GH="$(command -v gh)"
[ -f "$NOTION/app.asar" ] || { echo "Notion.app not found"; exit 1; }
[ -n "$GH" ] || { echo "gh not found (brew install gh)"; exit 1; }
cp "$NOTION/app.asar" "$W/targets/"
cp -R "$NOTION/app.asar.unpacked" "$W/targets/"
cp "$(find "$NOTION/app.asar.unpacked" -name mac_utils.node | head -1)" "$W/targets/"
cp "$GH" "$W/targets/gh"
(cd "$W/rea-install" && npm init -y >/dev/null && npm install rea-agents@6.5.0 --ignore-scripts >/dev/null)
node -e 'const [,p,o]=process.argv;require("fs").writeFileSync(o,JSON.stringify({mcpServers:{rea:{command:"node",args:[p,"--mcp"]}}}))' "$W/rea-install/node_modules/rea-agents/scripts/rea.mjs" "$W/rea-mcp.json"
echo "ready: $W"
echo "NOTE: answer keys in tasks.json match Notion 7.35.1 and gh built with go1.27.1; other versions need new keys."
