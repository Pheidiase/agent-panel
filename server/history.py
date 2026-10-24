"""Read only session metadata; never read prompts/messages or mutate agent databases."""
import json, re, sqlite3, pathlib, sys
home = pathlib.Path.home()
projects = json.loads(sys.argv[1])
result = []
for agent, filename in [('hermes', home/'.hermes/state.db'), ('codex', home/'.codex/state_5.sqlite')]:
    if not filename.exists(): continue
    try:
        db = sqlite3.connect(f'file:{filename}?mode=ro', uri=True, timeout=1)
        db.execute('PRAGMA query_only=ON')
        if agent == 'hermes':
            rows = db.execute("SELECT id,title,cwd,last_activity_at,source FROM sessions WHERE archived=0 AND hidden=0 ORDER BY last_activity_at DESC LIMIT 60")
        else:
            rows = db.execute("SELECT id,title,cwd,updated_at,source FROM threads WHERE archived=0 AND agent_role IS NULL ORDER BY updated_at DESC LIMIT 60")
        for sid,title,cwd,updated,source in rows:
            if not cwd: continue
            resolved = pathlib.Path(cwd).resolve()
            # More specific project roots win over the general home workspace.
            p = next((p for p in sorted(projects, key=lambda p:len(pathlib.Path(p['path']).parts), reverse=True) if resolved.is_relative_to(pathlib.Path(p['path']))), None)
            if p:
                result.append({'id':sid,'agentId':agent,'projectId':p['id'],'title':(title or 'İsimsiz sohbet')[:100],'updatedAt':updated,'source':source or agent,'readOnly':True})
        db.close()
    except sqlite3.Error:
        pass
# Claude Code keeps one <session-uuid>.jsonl per session under a directory
# named after the cwd (every non-alphanumeric character becomes "-"). Only the
# directory name, file name and mtime are used; the transcript is never opened.
claude_root = home/'.claude'/'projects'
if claude_root.is_dir():
    encode = lambda p: re.sub(r'[^a-zA-Z0-9]', '-', str(p))
    by_specificity = sorted(projects, key=lambda p:len(pathlib.Path(p['path']).parts), reverse=True)
    try:
        files = []
        for folder in claude_root.iterdir():
            if not folder.is_dir(): continue
            # Exact cwd match for a project; anything else under the home
            # directory belongs to the general entry (the encoding is lossy).
            p = next((p for p in by_specificity if encode(p['path']) == folder.name), None) or \
                next((p for p in by_specificity if p.get('kind') == 'general' and (folder.name == encode(p['path']) or folder.name.startswith(encode(p['path']) + '-'))), None)
            if not p: continue
            for f in folder.glob('*.jsonl'):
                if re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', f.stem):
                    files.append((f.stat().st_mtime, f.stem, p))
        for updated, sid, p in sorted(files, reverse=True)[:60]:
            result.append({'id':sid,'agentId':'claude','projectId':p['id'],'title':'Claude Code oturumu · '+sid[:8],'updatedAt':updated,'source':'claude','readOnly':True})
    except OSError:
        pass
print(json.dumps(sorted(result,key=lambda r:r['updatedAt'] or 0,reverse=True)[:40], ensure_ascii=False))
