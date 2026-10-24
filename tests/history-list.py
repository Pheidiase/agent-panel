"""Isolated metadata fixtures; refuses every Claude transcript content read."""
import builtins
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

SCRIPT = Path(__file__).resolve().parents[1] / 'server/history.py'


class HistoryList(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='panel-history-list-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.projects = [{'id': 'home', 'path': str(self.home), 'kind': 'general'},
                         {'id': 'p', 'path': str(self.home / 'project')},
                         {'id': 'nested', 'path': str(self.home / 'project/sub')}]
        self.databases = {}
        for agent, file, schema in [
            ('hermes', '.hermes/state.db', 'sessions (id TEXT, title TEXT, cwd TEXT, last_activity_at REAL, source TEXT, archived INTEGER, hidden INTEGER)'),
            ('codex', '.codex/state_5.sqlite', 'threads (id TEXT, title TEXT, cwd TEXT, updated_at REAL, source TEXT, archived INTEGER, agent_role TEXT)')]:
            target = self.home / file
            target.parent.mkdir()
            db = sqlite3.connect(target)
            db.execute('CREATE TABLE ' + schema)
            self.databases[agent] = db
            self.addCleanup(db.close)

    def add(self, agent, sid, cwd, time, archived=0, extra=None):
        table = 'sessions' if agent == 'hermes' else 'threads'
        db = self.databases[agent]
        db.execute(f'INSERT INTO {table} VALUES (?,?,?,?,?,?,?)',
                   (sid, 'title', str(cwd) if cwd else None, time, 'fixture', archived,
                    (extra or 0) if agent == 'hermes' else extra))
        db.commit()

    def claude(self, cwd, sid, time):
        import re
        folder = self.home / '.claude/projects' / re.sub(r'[^a-zA-Z0-9]', '-', str(cwd))
        folder.mkdir(parents=True, exist_ok=True)
        file = folder / (sid + '.jsonl')
        file.write_text('PRIVATE TRANSCRIPT MUST NOT BE READ')
        os.utime(file, (time, time))

    def snapshot(self):
        return {str(p.relative_to(self.home)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.home.rglob('*') if p.is_file()}

    def run_history(self):
        original_open, path_open = builtins.open, Path.open
        def safe_open(file, *args, **kwargs):
            if str(file).endswith('.jsonl'):
                raise AssertionError('Claude transcript opened')
            return original_open(file, *args, **kwargs)
        def safe_path(file, *args, **kwargs):
            if str(file).endswith('.jsonl'):
                raise AssertionError('Claude transcript opened')
            return path_open(file, *args, **kwargs)
        output = io.StringIO()
        with patch.dict(os.environ, {'HOME': str(self.home)}), \
             patch.object(sys, 'argv', [str(SCRIPT), json.dumps(self.projects)]), \
             patch('builtins.open', safe_open), patch.object(Path, 'open', safe_path), \
             redirect_stdout(output):
            runpy.run_path(str(SCRIPT), run_name='__main__')
        return json.loads(output.getvalue())

    def test_specific_projects_filters_readonly_and_corrupt_database(self):
        self.add('hermes', 'nested', self.home / 'project/sub/deeper', 100)
        self.add('hermes', 'general', self.home, 50)
        self.add('hermes', 'archived', self.home, 500, archived=1)
        self.add('hermes', 'hidden', self.home, 500, extra=1)
        self.add('hermes', 'outside', '/outside', 500)
        self.add('hermes', 'missing', None, 500)
        self.add('codex', 'project', self.home / 'project', 90)
        self.add('codex', 'subagent', self.home, 500, extra='worker')
        self.add('codex', 'archive', self.home, 500, archived=1)
        self.claude(self.home / 'project/sub', '11111111-1111-4111-8111-111111111111', 110)
        self.claude(str(self.home) + 'evil', '22222222-2222-4222-8222-222222222222', 600)
        self.claude(self.home, 'agent-not-a-uuid', 600)
        before = self.snapshot()
        rows = self.run_history()
        self.assertEqual([r['id'] for r in rows], ['11111111-1111-4111-8111-111111111111', 'nested', 'project', 'general'])
        self.assertEqual([r['projectId'] for r in rows], ['nested', 'nested', 'p', 'home'])
        self.assertTrue(all(r['readOnly'] for r in rows))
        self.assertEqual(self.snapshot(), before)
        self.databases['hermes'].close()
        (self.home / '.hermes/state.db').write_text('corrupt')
        self.assertEqual([r['agentId'] for r in self.run_history()], ['claude', 'codex'])

    def test_three_agents_sorted_and_capped(self):
        for i in range(70):
            self.add('hermes', f'h{i}', self.home, i)
            self.add('codex', f'c{i}', self.home, i + .5)
            self.claude(self.home, f'11111111-1111-4111-8111-{i:012d}', i + .75)
        before = self.snapshot()
        rows = self.run_history()
        self.assertEqual(len(rows), 40)
        self.assertEqual(rows[0]['updatedAt'], 69.75)
        self.assertEqual({r['agentId'] for r in rows}, {'hermes', 'codex', 'claude'})
        self.assertEqual([r['updatedAt'] for r in rows], sorted([r['updatedAt'] for r in rows], reverse=True))
        self.assertEqual(self.snapshot(), before)
        self.projects = [{'id': 'outside', 'path': str(self.home / 'other')}]
        self.assertEqual(self.run_history(), [])


if __name__ == '__main__':
    unittest.main()
