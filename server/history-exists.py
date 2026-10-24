"""Read only: which of the given "agent:id" history keys still exist in the agents' own stores.
Never reads message content and never writes. Prints a JSON list of the keys that exist."""
import json, re, sqlite3, pathlib, sys
home = pathlib.Path.home()
keys = json.loads(sys.argv[1])
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
SAFE = re.compile(r'[A-Za-z0-9._-]{1,200}')

def ids_in(db_path, table, wanted):
    """Subset of `wanted` present in `table.id`; None when the store cannot be read."""
    if not db_path.exists(): return set()
    try:
        db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=1)
        db.execute('PRAGMA query_only=ON')
        found = set()
        for i in range(0, len(wanted), 200):
            chunk = wanted[i:i+200]
            q = ','.join('?' * len(chunk))
            found.update(r[0] for r in db.execute(f'SELECT id FROM {table} WHERE id IN ({q})', chunk))
        db.close()
        return found
    except sqlite3.Error:
        return None

by_agent = {'hermes': [], 'codex': [], 'claude': []}
for key in keys:
    agent, _, sid = key.partition(':')
    if agent in by_agent and SAFE.fullmatch(sid): by_agent[agent].append(sid)

exist = []
unknown = set()
for agent, db_path, table in (('hermes', home/'.hermes/state.db', 'sessions'), ('codex', home/'.codex/state_5.sqlite', 'threads')):
    found = ids_in(db_path, table, by_agent[agent])
    if found is None: unknown.add(agent); continue
    exist += [f'{agent}:{i}' for i in found]
root = home/'.claude'/'projects'
for sid in by_agent['claude']:
    if not UUID.fullmatch(sid): continue
    try:
        if any((d/f'{sid}.jsonl').exists() for d in root.iterdir() if d.is_dir()): exist.append(f'claude:{sid}')
    except OSError:
        unknown.add('claude')
# A store that could not be read keeps its keys: never forget on a failed read.
exist += [k for k in keys if k.partition(':')[0] in unknown]
print(json.dumps(exist))
