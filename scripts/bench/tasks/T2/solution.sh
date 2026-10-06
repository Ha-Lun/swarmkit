sed -i "s/'fast': 'haiku'/'fast': 'sonnet'/" scripts/build.py
python3 scripts/build.py >/dev/null
