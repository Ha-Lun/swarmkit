#!/usr/bin/env bash
# Rebuild the dashboard's scripted demo and copy it into public/dashboard-demo/.
# Usage: scripts/sync-dashboard-demo.sh <dashboard-dir>
set -euo pipefail

src="${1:?usage: sync-dashboard-demo.sh <dashboard-dir>}"
site="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$(cd "$src" && pwd)"
dest="$site/public/dashboard-demo"

(cd "$src" && npm run build:demo)

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$src/dist-demo/." "$dest/"

printf 'dashboard commit: %s\nsynced: %s\n' "$(git -C "$src" rev-parse --short HEAD)" "$(date +%F)" > "$dest/SOURCE.txt"

if hits="$(grep -rIl "ha-lun\|lundstrom\|tail3e28e1" "$dest")"; then
  echo "refusing: private strings found in the demo build:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "synced $(du -sh "$dest" | cut -f1) into public/dashboard-demo"
