sed -i '/^description:/s/context-gathering/contxt-gathering/' core/agents/explore.md
python3 scripts/build.py >/dev/null
