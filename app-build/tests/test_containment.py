"""What the builder can and cannot leave for the steps after it.

The build job's later steps mint tokens with the GitHub App private key and
post to the Slack webhook, so a segment must end with nothing of the builder's
still running, no git configuration it planted, no file command it wrote, and
no Slack message it queued. Feedback must come only from people the caller
trusts, on the build PR in this repository.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

from feedback_harness import TOOLS, Workspace, at, comment


class FeedbackTrust(unittest.TestCase):
    def test_star_admits_owners_members_and_collaborators_only(self):
        w = Workspace(self, authors='*', comments=[
            comment(1, at(0), who='owner', assoc='OWNER'),
            comment(2, at(1), who='member', assoc='MEMBER'),
            comment(3, at(2), who='collab', assoc='COLLABORATOR'),
            comment(4, at(3), who='drive-by', assoc='NONE'),
            comment(5, at(4), who='contrib', assoc='CONTRIBUTOR'),
            comment(6, at(5), who='newcomer', assoc='FIRST_TIME_CONTRIBUTOR'),
        ])
        r = w.run_feedback()
        self.assertEqual(w.batch()['keys'], ['comment:1', 'comment:2', 'comment:3'])
        self.assertIn('3 from anyone else ignored', r.stdout)

    def test_a_named_login_is_heard_whatever_its_association(self):
        w = Workspace(self, authors='drive-by', comments=[comment(1, at(0), who='drive-by', assoc='NONE')])
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], ['comment:1'])

    def test_a_fork_pr_from_the_same_branch_name_is_not_the_build_pr(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.set_fixtures(prs=[
            {'number': 27, 'state': 'OPEN', 'labels': [], 'isCrossRepository': False,
             'headRepositoryOwner': {'login': 'example'}},
            {'number': 99, 'state': 'OPEN', 'labels': [], 'isCrossRepository': True,
             'headRepositoryOwner': {'login': 'someone-else'}},
        ])
        w.run_feedback()
        self.assertEqual((w.rt / 'pr-number').read_text(), '27')

    def test_only_a_fork_pr_means_no_build_pr(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.set_fixtures(prs=[{'number': 99, 'state': 'OPEN', 'labels': [], 'isCrossRepository': True,
                             'headRepositoryOwner': {'login': 'someone-else'}}])
        r = w.run_feedback()
        self.assertIn('No PR for lexi/build-web yet', r.stdout)
        self.assertFalse((w.rt / 'pr-number').exists())
        self.assertIsNone(w.batch())


class SegmentContainment(unittest.TestCase):
    def file_commands(self, w):
        paths = {}
        for name in ('GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT'):
            p = w.root / f'{name.lower()}-{w.session}'
            p.write_text('')
            paths[name] = str(p)
        return paths

    def test_the_builder_leaves_no_git_configuration_file_command_or_slack_message(self):
        w = Workspace(self)
        hooks = w.ws / '.git' / 'hooks'
        before = sorted(p.name for p in hooks.iterdir()) if hooks.exists() else []
        env = self.file_commands(w)
        w.run_feedback()
        w.run_segment(1, STUB_CLAUDE_MODE='tamper', **env)
        config = subprocess.run(['git', 'config', '--get', 'core.fsmonitor'], cwd=w.ws,
                                capture_output=True, text=True)
        self.assertEqual(config.stdout, '', 'core.fsmonitor was put back')
        after = sorted(p.name for p in hooks.iterdir()) if hooks.exists() else []
        self.assertEqual(after, before, 'the planted hook is gone')
        self.assertEqual(Path(env['GITHUB_ENV']).read_text(), 'LEXI_SEGMENT_PHASE=build\n')
        self.assertEqual(Path(env['GITHUB_PATH']).read_text(), '')
        self.assertEqual(Path(env['GITHUB_OUTPUT']).read_text(), '')
        self.assertFalse((w.rt / 'slack-outbox').exists(), 'nothing the builder queued is posted')

    @unittest.skipUnless(os.path.isdir('/proc/self'), 'the sweep reads /proc (Linux)')
    def test_a_detached_helper_does_not_outlive_its_segment(self):
        w = Workspace(self)
        w.run_feedback()
        w.run_segment(1, STUB_CLAUDE_MODE='detach')
        pid = int((w.stub / 'child-1').read_text())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.kill(pid, 9)
            self.fail('the detached helper is still running after the segment')

    def test_the_gate_reviewer_gets_no_staging_credential_or_token(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        secret = 'MARK-1-END'
        w.run(['bash', str(w.rt / 'app-build/gate.sh'), 'intent'], LEXI_PHASES='true',
              STAGING_REAL_PASSWORD=secret, MAILISK_API_KEY=secret, GH_TOKEN=secret)
        self.assertFalse(w.stub_env(1)['body_in_env'])


class AssessContainment(unittest.TestCase):
    def test_the_review_gets_no_token_or_staging_credential_and_leaves_no_file_command(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        (w.ws / 'app/web/README.md').write_text('changed\n')
        files = {}
        for name in ('GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT'):
            p = w.root / f'{name.lower()}-assess'
            p.write_text('LD_PRELOAD=/tmp/planted.so\n')
            files[name] = str(p)
        secret = 'MARK-1-END'
        w.run(['bash', str(w.rt / 'app-build/assess.sh'), 'review'],
              GH_TOKEN=secret, STAGING_REAL_PASSWORD=secret, MAILISK_API_KEY=secret, **files)
        self.assertFalse(w.stub_env(1)['body_in_env'])
        for p in files.values():
            self.assertEqual(Path(p).read_text(), '')

    def test_an_unknown_part_is_refused(self):
        w = Workspace(self)
        r = w.run(['bash', str(w.rt / 'app-build/assess.sh'), 'deploy'], check_rc=2)
        self.assertIn('usage: assess.sh', r.stderr)


class _Hook(http.server.BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        _Hook.received.append(json.loads(body))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


class SlackPost(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.rt = Path(self.tmp.name)
        self.outbox = self.rt / 'slack-outbox'
        self.outbox.mkdir()
        (self.outbox / 'gate-intent-1.json').write_text(json.dumps({'text': 'intent PASS', 'extra': 'dropped'}))
        (self.outbox / 'broken.json').write_text('not json')

    def run_post(self, url):
        env = {'PATH': os.environ['PATH'], 'RUNNER_TEMP': str(self.rt)}
        if url:
            env['LEXI_SLACK_WEBHOOK_URL'] = url
        return subprocess.run(['bash', str(TOOLS / 'slack-post.sh')], env=env, capture_output=True, text=True)

    def test_posts_only_the_text_of_each_queued_message(self):
        _Hook.received = []
        server = http.server.HTTPServer(('127.0.0.1', 0), _Hook)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        r = self.run_post(f'http://127.0.0.1:{server.server_port}/hook')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(_Hook.received, [{'text': 'intent PASS'}])
        self.assertIn('Posted 1 gate verdict(s) to Slack.', r.stdout)
        self.assertFalse(self.outbox.exists())

    def test_without_a_webhook_nothing_is_sent_and_the_queue_is_dropped(self):
        r = self.run_post(None)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.outbox.exists())


if __name__ == '__main__':
    unittest.main()
