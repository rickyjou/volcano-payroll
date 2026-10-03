#!/bin/sh
# Runs the Volcano CLI with this repo's own cloud login, separate from the global one.
# The CLI keeps its login and active project in $HOME/.volcano/config.json, so pointing
# HOME at the gitignored .volcano-cloud/ directory gives this repo its own account and
# project without touching the login other projects use.
#   npm run cloud -- login
#   npm run cloud -- use 1dc794d1-99e0-4c56-af27-e10b6842f924
#   npm run cloud -- cloud functions deploy --all
# Keep using plain `volcano` for the local stack (start, status, migrations, functions deploy).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/.volcano-cloud"
cd "$ROOT"
HOME="$ROOT/.volcano-cloud" exec volcano "$@"
