"""Shared harness for the feedback delivery tests (not a test module itself).

A temp build workspace (git repo), a runner temp dir with a copy of app-build/,
a `gh` double serving PR comments from a JSON file, a stub `claude` that
records its argv, stdin and environment, and, on macOS, a `timeout` shim.
Nothing here talks to GitHub or a model.
"""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

TOOLS = Path(__file__).resolve().parents[1]
SANDBOX = TOOLS.parent / 'agent-fix' / 'scripts' / 'agent-sandbox.sh'
REPO = 'example/app'
PR = 27
DOCS = 'app/web/docs/build'

# The gh double. Fixtures: {"comments": [...], "reviews": [...], "inline": [...],
# "<other endpoint>": <answer>}. GH_FAIL=<substring> fails matching endpoints.
GH = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
jq = args[args.index('--jq') + 1] if '--jq' in args else None
path_f = os.environ['GH_FIXTURES']
fixtures = json.load(open(path_f))
fail = os.environ.get('GH_FAIL', '')
if args[:2] == ['pr', 'list']:
    out = json.dumps(fixtures.get('prs', [{'number': 27, 'state': 'OPEN', 'labels': [],
                                           'isCrossRepository': False, 'headRepositoryOwner': {'login': 'example'}}]))
elif args[:2] == ['pr', 'view']:
    out = json.dumps({'headRefOid': 'abc1234def'})
elif args[:2] == ['pr', 'comment']:
    body = open(args[args.index('--body-file') + 1]).read()
    comments = fixtures.setdefault('comments', [])
    at = max([c['created_at'] for c in comments] + ['2026-10-01T00:00:00Z'])
    import datetime
    t = datetime.datetime.strptime(at, '%Y-%m-%dT%H:%M:%SZ') + datetime.timedelta(minutes=1)
    new_id = max([c['id'] for c in comments] + [9000]) + 1
    comments.append({'id': new_id, 'node_id': 'IC_report%d' % new_id, 'created_at': t.strftime('%Y-%m-%dT%H:%M:%SZ'),
                     'user': {'login': 'lexi-github-app[bot]', 'type': 'Bot'},
                     'performed_via_github_app': {'id': 4242}, 'body': body})
    json.dump(fixtures, open(path_f, 'w'))
    open(os.path.join(os.environ['RUNNER_TEMP'], 'posted.md'), 'w').write(body)
    sys.exit(0)
else:
    path = next(a for a in args if a.startswith('repos/'))
    if fail and fail in path:
        sys.exit(1)
    names = {'repos/example/app/issues/27/comments': 'comments',
             'repos/example/app/pulls/27/reviews': 'reviews',
             'repos/example/app/pulls/27/comments': 'inline'}
    if path in names:
        out = fixtures.get(names[path], [])
    elif path in fixtures:
        out = fixtures[path]
    else:
        sys.exit(1)
    if not isinstance(out, str):
        out = json.dumps(out)
if jq:
    out = subprocess.run(['jq', '-rc', jq], input=out, capture_output=True, text=True, check=True).stdout
sys.stdout.write(out)
'''

# The stub builder. Mode from STUB_MODES (comma list, by call number) or
# STUB_CLAUDE_MODE. Writes argv-<n>.json, stdin-<n>.txt, env-<n>.json, pid-<n>.
CLAUDE = r'''#!/usr/bin/env python3
import json, os, re, signal, subprocess, sys, time
d = os.environ['STUB_DIR']
count_f = os.path.join(d, 'count')
n = int(open(count_f).read()) + 1 if os.path.exists(count_f) else 1
open(count_f, 'w').write(str(n))
modes = [m for m in os.environ.get('STUB_MODES', '').split(',') if m]
mode = modes[n - 1] if n <= len(modes) else os.environ.get('STUB_CLAUDE_MODE', 'ok')
open(os.path.join(d, 'pid-%d' % n), 'w').write(str(os.getpid()))
stdin = sys.stdin.read()
open(os.path.join(d, 'stdin-%d.txt' % n), 'w').write(stdin)
json.dump(sys.argv[1:], open(os.path.join(d, 'argv-%d.json' % n), 'w'))
marks = []
if os.environ.get('STUB_BODIES') and os.path.exists(os.environ['STUB_BODIES']):
    marks = json.load(open(os.environ['STUB_BODIES']))
env_text = '\n'.join('%s=%s' % kv for kv in os.environ.items())
argv_text = '\n'.join(sys.argv[1:])
json.dump({'bytes': len(env_text.encode()), 'body_in_env': any(m in env_text for m in marks),
           'body_in_argv': any(m in argv_text for m in marks)},
          open(os.path.join(d, 'env-%d.json' % n), 'w'))
open(os.path.join(d, 'mode-%d' % n), 'w').write(mode)

def emit(o):
    sys.stdout.write(json.dumps(o) + '\n')
    sys.stdout.flush()

INIT = {'type': 'system', 'subtype': 'init', 'session_id': 'stub-session-%d' % n, 'model': 'stub'}
ASSIST = {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'working'}]}}
OK = {'type': 'result', 'subtype': 'success', 'is_error': False, 'num_turns': 1, 'total_cost_usd': 0}

if mode == 'noinit':
    sys.exit(0)
if mode == 'hang_ignore':
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
emit(INIT)
if mode in ('hang', 'hang_ignore', 'hang_child'):
    if mode == 'hang_child':
        child = subprocess.Popen(['sleep', '600'])
        open(os.path.join(d, 'child-%d' % n), 'w').write(str(child.pid))
    open(os.path.join(d, 'running-%d' % n), 'w').write('1')
    time.sleep(600)
    sys.exit(0)
if mode == 'deadline_noassist':
    sys.exit(124)
if mode == 'detach':
    # A helper in its own session, the way `setsid` or `nohup` leaves one.
    child = subprocess.Popen(['sleep', '600'], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    open(os.path.join(d, 'child-%d' % n), 'w').write(str(child.pid))
if mode == 'tamper':
    # What a builder could leave for the workflow's later steps.
    ws = os.environ['GITHUB_WORKSPACE']
    subprocess.run(['git', 'config', 'core.fsmonitor', 'touch /tmp/never'], cwd=ws, check=True)
    hook = os.path.join(ws, '.git', 'hooks', 'pre-push')
    open(hook, 'w').write('#!/bin/sh\nexit 0\n')
    for name in ('GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT'):
        if os.environ.get(name):
            open(os.environ[name], 'a').write('LD_PRELOAD=/tmp/evil.so\n')
    outbox = os.path.join(os.environ['RUNNER_TEMP'], 'slack-outbox')
    os.makedirs(outbox, exist_ok=True)
    open(os.path.join(outbox, 'planted.json'), 'w').write('{"text": "planted"}')
if mode == 'swap':
    open(os.path.join(d, 'waiting-%d' % n), 'w').write('1')
    for _ in range(600):
        if os.path.exists(os.path.join(d, 'go')):
            break
        time.sleep(0.1)
emit(ASSIST)
if mode == 'exit1':
    emit({'type': 'result', 'subtype': 'error_during_execution', 'is_error': True})
    sys.exit(1)
if mode == 'is_error':
    emit(dict(OK, is_error=True))
    sys.exit(0)
if mode == 'deadline':
    sys.exit(124)
if mode == 'sigint130':
    sys.exit(130)
if mode in ('ok_read_ref', 'ok_read_ref_error'):
    found = re.findall(r'`([^`\s]*/\.lexi-feedback/ref-[^`\s]*\.md)`', stdin)
    path = found[0] if found else '/nonexistent'
    if os.environ.get('STUB_READ_PATH_FORMAT') == 'odd':
        path = path.replace('/.lexi-feedback/', '//.lexi-feedback/./')
    emit({'type': 'assistant', 'message': {'content': [
        {'type': 'tool_use', 'id': 'toolu_1', 'name': 'Read', 'input': {'file_path': path}}]}})
    emit({'type': 'user', 'message': {'content': [
        {'type': 'tool_result', 'tool_use_id': 'toolu_1', 'is_error': mode == 'ok_read_ref_error',
         'content': 'file text'}]}})
emit(OK)
sys.exit(0)
'''

TIMEOUT_SHIM = '''#!/bin/bash
# Test stand-in for GNU timeout: drops the options and the duration.
while [ "$#" -gt 0 ]; do
  case "$1" in --signal=*|--kill-after=*) shift ;; *) break ;; esac
done
shift
exec "$@"
'''


def system_path():
    """PATH without any directory holding a real `claude`: the tests must only
    ever reach the stub (and a test that removes the stub must find none)."""
    return ':'.join(d for d in os.environ['PATH'].split(':')
                    if d and not os.path.exists(os.path.join(d, 'claude')))


def git(cwd, *args):
    return subprocess.run(['git', '-c', 'user.name=T', '-c', 'user.email=t@example.test',
                           '-c', 'commit.gpgsign=false', *args],
                          cwd=cwd, capture_output=True, text=True, check=True).stdout


def comment(cid, at, who='alice', body=None, kind='comment', human=None, path='src/a.ts', assoc=None):
    """One fixture item in the REST shape of its endpoint."""
    human = (not who.endswith('[bot]')) if human is None else human
    assoc = assoc if assoc is not None else ('MEMBER' if human else 'NONE')
    body = body if body is not None else f'Please fix item {cid}. MARK-{cid}-END'
    item = {'id': cid, 'node_id': f'IC_node{cid}', 'user': {'login': who, 'type': 'User' if human else 'Bot'},
            'author_association': assoc, 'body': body}
    if who == 'lexi-github-app[bot]':
        # Posted with the workflow's App token, as report.sh does.
        item['performed_via_github_app'] = {'id': 4242}
    if kind == 'review':
        item['submitted_at'] = at
        item['node_id'] = f'PRR_node{cid}'
    else:
        item['created_at'] = at
    if kind == 'inline':
        item['path'] = path
        item['node_id'] = f'PRRC_node{cid}'
    return item


def at(minute, base='2026-10-10T12:00:00Z'):
    """An ISO time `minute` minutes after `base`."""
    t = datetime.datetime.strptime(base, '%Y-%m-%dT%H:%M:%SZ') + datetime.timedelta(minutes=minute)
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def make_comments(n, size, start_id=1000, who='alice', multibyte=True, minute0=0):
    """n comments of about `size` bytes each, one minute apart, oldest first."""
    out = []
    for i in range(n):
        cid = start_id + i
        head = f'Comment {cid}: MARK-{cid}-END '
        filler = ('Ünïcödé ✓ — ' if multibyte else 'plain text ') * (size // 16 + 1)
        body = (head + filler).encode()[:size].decode('utf-8', 'ignore')
        out.append(comment(cid, at(minute0 + i), who=who, body=body))
    return out


class Workspace:
    """One build workspace; `new_session()` gives a fresh runner temp dir."""

    def __init__(self, testcase, comments=(), reviews=(), inline=(), authors='alice,qa-bot[bot]',
                 docs_dir=True):
        self.t = testcase
        self.tmp = tempfile.TemporaryDirectory()
        testcase.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ws = self.root / 'ws'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.ws.mkdir()
        git(self.ws, 'init', '-q')
        (self.ws / 'app/web').mkdir(parents=True)
        (self.ws / 'app/web/README.md').write_text('app\n')
        if docs_dir:
            (self.ws / DOCS).mkdir(parents=True)
            (self.ws / DOCS / 'PROGRESS.md').write_text('Status: in progress\n')
        git(self.ws, 'add', '-A')
        git(self.ws, 'commit', '-q', '-m', 'seed')
        self.fixtures = self.root / 'fixtures.json'
        self.fixtures.write_text(json.dumps({'comments': list(comments), 'reviews': list(reviews),
                                             'inline': list(inline)}))
        self.bodies = self.root / 'bodies.json'
        self.update_bodies()
        for name, text in (('gh', GH), ('claude', CLAUDE)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        if shutil.which('timeout') is None:
            (self.bin / 'timeout').write_text(TIMEOUT_SHIM)
            (self.bin / 'timeout').chmod(0o755)
        self.authors = authors
        self.session = 0
        self.extra_env = {}
        self.new_session()

    # ---- fixtures ---------------------------------------------------------
    def data(self):
        return json.loads(self.fixtures.read_text())

    def set_fixtures(self, **kinds):
        d = self.data()
        d.update({k: list(v) for k, v in kinds.items()})
        self.fixtures.write_text(json.dumps(d))
        self.update_bodies()

    def add_comments(self, items):
        d = self.data()
        d['comments'] = d.get('comments', []) + list(items)
        self.fixtures.write_text(json.dumps(d))
        self.update_bodies()

    def update_bodies(self):
        d = json.loads(self.fixtures.read_text())
        marks = []
        for kind in ('comments', 'reviews', 'inline'):
            for c in d.get(kind, []):
                marks.append(f'MARK-{c["id"]}-END')
        self.bodies.write_text(json.dumps(marks))

    # ---- sessions ---------------------------------------------------------
    def new_session(self):
        self.session += 1
        self.rt = self.root / f'rt{self.session}'
        self.rt.mkdir()
        self.stub = self.root / f'stub{self.session}'
        self.stub.mkdir()
        shutil.copytree(TOOLS, self.rt / 'app-build', ignore=shutil.ignore_patterns('tests', '__pycache__'))
        # The workflow seals this into the tools archive beside app-build/.
        shutil.copy(SANDBOX, self.rt / 'app-build' / 'agent-sandbox.sh')
        (self.rt / 'mcp.json').write_text('{"mcpServers": {}}')
        (self.rt / 'start-sha').write_text(git(self.ws, 'rev-parse', 'HEAD').strip())
        return self.rt

    def env(self, **extra):
        env = {
            'PATH': f'{self.bin}:{system_path()}',
            'HOME': os.environ.get('HOME', str(self.root)),
            'LEXI_APP': 'web', 'LEXI_APP_ID': '4242', 'LEXI_APP_DIR': 'app/web', 'LEXI_DOCS_DIR': DOCS, 'LEXI_APP_LABEL': 'Example app',
            'LEXI_SESSION': str(self.session), 'LEXI_MAX_SESSIONS': '30', 'LEXI_SEGMENTS': '3',
            'LEXI_SEGMENT_MINUTES': '1', 'LEXI_MODEL': 'stub-model', 'LEXI_TESTS': 'unit',
            'LEXI_BROWSER_CHECK': 'false', 'LEXI_BRANCH': 'lexi/build-web', 'LEXI_RESUME_SEGMENTS': 'false',
            'GITHUB_REPOSITORY': REPO, 'GITHUB_RUN_ID': f'run{self.session}', 'GITHUB_WORKSPACE': str(self.ws),
            'GITHUB_SERVER_URL': 'https://github.com',
            'RUNNER_TEMP': str(self.rt), 'LEXI_FEEDBACK_AUTHORS': self.authors,
            'GH_FIXTURES': str(self.fixtures), 'STUB_DIR': str(self.stub), 'STUB_BODIES': str(self.bodies),
            # The sweep at the end of a segment stops only this workspace's
            # processes (the stub builder and what it started), never another
            # test's or the test runner's.
            'LEXI_SANDBOX_REQUIRE_ENV': f'STUB_DIR={self.stub}',
        }
        env.update(self.extra_env)
        env.update({k: v for k, v in extra.items() if v is not None})
        for k, v in extra.items():
            if v is None:
                env.pop(k, None)
        return env

    def run(self, args, check_rc=0, **env):
        result = subprocess.run(args, cwd=self.ws, env=self.env(**env), capture_output=True, text=True)
        if check_rc is not None:
            self.t.assertEqual(result.returncode, check_rc, result.stdout + result.stderr)
        return result

    def run_feedback(self, check_rc=0, **env):
        return self.run(['bash', str(self.rt / 'app-build/feedback.sh')], check_rc, **env)

    def run_segment(self, n, check_rc=0, **env):
        return self.run(['bash', str(self.rt / 'app-build/segment.sh'), str(n)], check_rc, **env)

    def start_segment(self, n, **env):
        return subprocess.Popen(['bash', str(self.rt / 'app-build/segment.sh'), str(n)], cwd=self.ws,
                                env=self.env(**env), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def run_cursor(self, *args, check_rc=0, **env):
        return self.run(['bash', str(self.rt / 'app-build/feedback-cursor.sh'), *args], check_rc, **env)

    def run_report(self, check_rc=0, **env):
        return self.run(['bash', str(self.rt / 'app-build/report.sh'), 'session'], check_rc, **env)

    def session_loop(self, segments=3, modes=None, **env):
        """feedback.sh, then segment 1, refresh, segment 2, ... like the workflow."""
        if modes is not None:
            env['STUB_MODES'] = ','.join(modes)
        outs = [self.run_feedback(**env)]
        for n in range(1, segments + 1):
            outs.append(self.run_segment(n, check_rc=None, **env))
            if n < segments:
                outs.append(self.run_feedback(**env))
        return outs

    # ---- state ------------------------------------------------------------
    def read_cursor(self):
        f = self.rt / 'feedback-cursor.json'
        return json.loads(f.read_text()) if f.exists() else None

    def branch_cursor_path(self):
        return self.ws / DOCS / 'FEEDBACK_CURSOR.json'

    def branch_cursor(self):
        f = self.branch_cursor_path()
        return json.loads(f.read_text()) if f.exists() else None

    def batch(self):
        f = self.rt / 'feedback/batch.json'
        return json.loads(f.read_text()) if f.exists() else None

    def calls(self):
        f = self.stub / 'count'
        return int(f.read_text()) if f.exists() else 0

    def stdin(self, n):
        return (self.stub / f'stdin-{n}.txt').read_text()

    def argv(self, n):
        return json.loads((self.stub / f'argv-{n}.json').read_text())

    def stub_env(self, n):
        return json.loads((self.stub / f'env-{n}.json').read_text())

    def exits(self):
        f = self.rt / 'segment-exits'
        return f.read_text().split() if f.exists() else []

    def delivered_keys(self, n):
        """Keys of the comments inlined in the stub's n-th stdin, in order."""
        import re
        return ['comment:' + m for m in re.findall(r'MARK-(\d+)-END', self.stdin(n))]
