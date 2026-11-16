"""Exercise report formatting without posting comments or pushing artifacts."""
from html.parser import HTMLParser
from pathlib import Path
import os
import shlex
import shutil
import tempfile
import re
import subprocess
import unittest

REPORT = Path(__file__).resolve().parents[1] / 'report.sh'


class ReportTest(unittest.TestCase):
    def call(self, name, args=(), text='', env=None):
        source = REPORT.read_text()
        match = re.search(r'^' + name + r'\(\) \{.*?^\}', source, re.M | re.S)
        self.assertIsNotNone(match, f'{name} function missing')
        script = 'TOOLS=' + shlex.quote(str(REPORT.parent)) + '\n' + 'IMAGES_PUSHED=1; IMAGE_BASE=https://github.com/example/app/blob/reports\n' + match.group() + '\n' + name + ' "$@"'
        result = subprocess.run(['bash', '-uc', script, '_', *args], input=text, text=True, capture_output=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_image_filename_cannot_add_html_attributes(self):
        rendered = self.call('img', ('/shots/screen" onerror="alert(1)&.png',))
        class ImageParser(HTMLParser):
            attrs = []
            def handle_starttag(self, tag, attrs):
                self.attrs = attrs
        parser = ImageParser()
        parser.feed(rendered)
        self.assertEqual([name for name, _ in parser.attrs], ['src', 'width'])
        self.assertIn('%22', dict(parser.attrs)['src'])
        self.assertIn('%26', dict(parser.attrs)['src'])

    def test_credentials_are_redacted_before_an_excerpt_is_cut(self):
        env = dict(os.environ, STAGING_REAL_PASSWORD='fake-password-for-test')
        result = self.call('limit_text', ('7',), 'fake-password-for-test and more', env)
        self.assertTrue(result.startswith('[redact'))
        self.assertNotIn('fake-pa', result)

    def test_saved_and_posted_report_redacts_uncommitted_session_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runner = root / 'runner'
            (runner / 'app-build').mkdir(parents=True)
            for name in ('cost.mjs', 'redact-output.mjs'):
                shutil.copyfile(REPORT.parent / name, runner / 'app-build' / name)
            (runner / 'pr-number').write_text('1')
            docs = root / 'repo/app/web/docs/build'
            docs.mkdir(parents=True)
            secret = 'fake-password-for-report-test'
            (docs / 'LAST_SESSION.md').write_text(secret)
            (docs / 'PHASE').write_text('build')
            bindir = root / 'bin'
            bindir.mkdir()
            for name, body in {
                'git': '#!/bin/bash\nprintf deadbeef\n',
                'gh': '#!/bin/bash\ncp "${@: -1}" "$RUNNER_TEMP/posted.md"\n',
            }.items():
                target = bindir / name
                target.write_text(body)
                target.chmod(0o755)
            env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'], RUNNER_TEMP=str(runner),
                       GITHUB_WORKSPACE=str(root / 'repo'), LEXI_APP='web', LEXI_APP_DIR='app/web',
                       LEXI_APP_LABEL='Example app', LEXI_SESSION='1', LEXI_MAX_SESSIONS='3',
                       LEXI_BRANCH='example', GITHUB_SERVER_URL='https://github.com',
                       GITHUB_REPOSITORY='example/app', GITHUB_RUN_ID='123', STAGING_REAL_PASSWORD=secret)
            result = subprocess.run(['bash', str(REPORT), 'session'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in ('report.md', 'report.md.trim', 'posted.md'):
                text = (runner / name).read_text()
                self.assertNotIn(secret, text)
                self.assertIn('[redacted]', text)

    def feedback_report(self, files=None, push_outcome='success', with_cursor_script=True):
        """Run report.sh session with the given $RUNNER_TEMP files; return (result, posted body)."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runner = root / 'runner'
            (runner / 'app-build').mkdir(parents=True)
            names = ['cost.mjs', 'redact-output.mjs'] + (['feedback-cursor.sh'] if with_cursor_script else [])
            for name in names:
                shutil.copy(REPORT.parent / name, runner / 'app-build' / name)
            (runner / 'pr-number').write_text('1')
            for name, text in (files or {}).items():
                (runner / name).write_text(text)
            (root / 'repo/app/web/docs/build').mkdir(parents=True)
            (root / 'repo/app/web/docs/build/PHASE').write_text('build')
            bindir = root / 'bin'
            bindir.mkdir()
            for name, body in {
                'git': '#!/bin/bash\nprintf deadbeef\n',
                'gh': '#!/bin/bash\ncp "${@: -1}" "$RUNNER_TEMP/posted.md"\n',
            }.items():
                target = bindir / name
                target.write_text(body)
                target.chmod(0o755)
            env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'], RUNNER_TEMP=str(runner),
                       GITHUB_WORKSPACE=str(root / 'repo'), LEXI_APP='web', LEXI_APP_DIR='app/web',
                       LEXI_APP_LABEL='Example app', LEXI_SESSION='1', LEXI_MAX_SESSIONS='3',
                       LEXI_BRANCH='example', GITHUB_SERVER_URL='https://github.com',
                       GITHUB_REPOSITORY='example/app', GITHUB_RUN_ID='123')
            if push_outcome is not None:
                env['PUSH_OUTCOME'] = push_outcome
            result = subprocess.run(['bash', str(REPORT), 'session'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result, (runner / 'posted.md').read_text()

    CURSOR = '{"version": 1, "rev": 2, "safe_at": "2026-10-16T03:30:53Z", "replay": null}'
    START = '2026-10-12T17:53:23Z'

    def test_feedback_marker_is_the_processed_cursor_after_a_successful_push(self):
        _, posted = self.feedback_report({'feedback-cursor.json': self.CURSOR, 'feedback-cursor-tracked': '',
                                          'feedback-safe-at-start': self.START, 'feedback-pending': '3',
                                          'feedback-delivered.log': 'segment 1: 7 comment(s), 5000 bytes, comment:1..comment:7\n'})
        self.assertIn('<!-- app-build:feedback-cursor=v1 -->', posted)
        self.assertIn('<!-- app-build:feedback-read-at=2026-10-16T03:30:53Z -->', posted)
        self.assertIn('**Feedback:** 7 comment(s) delivered in 1 batch(es) this session; 3 pending.', posted)

    def test_feedback_marker_keeps_the_start_value_when_the_final_push_failed(self):
        for outcome in ('failure', None):
            with self.subTest(outcome=outcome):
                _, posted = self.feedback_report({'feedback-cursor.json': self.CURSOR, 'feedback-cursor-tracked': '',
                                                  'feedback-safe-at-start': self.START}, push_outcome=outcome)
                self.assertIn(f'<!-- app-build:feedback-read-at={self.START} -->', posted)
                self.assertNotIn('2026-10-16T03:30:53Z', posted)
                self.assertIn("the final push failed, so this session's feedback progress was not saved", posted)

    def test_untracked_session_republishes_its_start_value(self):
        _, posted = self.feedback_report({'feedback-cursor.json': self.CURSOR, 'feedback-safe-at-start': self.START})
        self.assertIn(f'<!-- app-build:feedback-read-at={self.START} -->', posted)
        _, posted = self.feedback_report({'feedback-cursor.json': self.CURSOR})
        self.assertNotIn('feedback-read-at', posted)
        self.assertIn('<!-- app-build:feedback-cursor=v1 -->', posted)

    def test_report_without_the_cursor_script_still_posts(self):
        result, posted = self.feedback_report({'feedback-safe-at-start': self.START}, with_cursor_script=False)
        self.assertEqual(result.stderr, '')
        self.assertIn('<!-- app-build:feedback-cursor=v1 -->', posted)
        self.assertNotIn('feedback-read-at', posted)

    def test_cursor_error_is_reported(self):
        _, posted = self.feedback_report({'feedback-cursor.json': self.CURSOR, 'feedback-safe-at-start': self.START,
                                          'feedback-cursor-error': 'cannot write'})
        self.assertIn('**Feedback:** ⚠️ the feedback cursor could not be saved; the same comments will be delivered again.', posted)
        self.assertIn(f'<!-- app-build:feedback-read-at={self.START} -->', posted)

    def test_replay_state_is_reported(self):
        cursor = '{"version": 1, "safe_at": "2026-10-16T03:30:53Z", "replay": {"from_key": "comment:6173802225", "delivered": []}}'
        _, posted = self.feedback_report({'feedback-cursor.json': cursor, 'feedback-cursor-tracked': ''})
        self.assertIn('Replay from comment:6173802225 requested; no batch processed yet', posted)
        cursor = cursor.replace('"delivered": []', '"delivered": ["comment:6173802225"]')
        _, posted = self.feedback_report({'feedback-cursor.json': cursor, 'feedback-cursor-tracked': ''})
        self.assertIn('Replay from comment:6173802225 in progress.', posted)

    def test_short_excerpts_are_preserved(self):
        self.assertEqual(self.call('limit_text', ('20',), 'short text'), 'short text')

    def test_long_excerpts_clearly_report_missing_content(self):
        result = self.call('limit_text', ('5',), 'abcdefghij')
        self.assertTrue(result.startswith('abcde'))
        self.assertNotIn('fghij', result)
        self.assertIn('Excerpt shortened', result)
        self.assertIn('run log', result)


class TrustedImageTest(unittest.TestCase):
    """report.sh publishes only real PNGs from the trusted check directories."""
    PNG = bytes.fromhex('89504e470d0a1a0a') + b'\0' * 16

    def trusted(self, out, path):
        source = REPORT.read_text()
        match = re.search(r'^trusted_image\(\) \{.*?^\}', source, re.M | re.S)
        self.assertIsNotNone(match)
        script = ('OUT=' + shlex.quote(str(out)) + '\nTRUSTED_IMAGE_DIRS=("$OUT/shots" "$OUT/visual")\n'
                  + match.group() + '\ntrusted_image "$1"')
        return subprocess.run(['bash', '-uc', script, '_', path], capture_output=True, text=True)

    def test_only_regular_pngs_in_the_trusted_directories_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'checks'
            (out / 'shots').mkdir(parents=True)
            (out / 'visual').mkdir()
            (out / 'shots/home__app__desktop.png').write_bytes(self.PNG)
            (out / 'shots/env__app__desktop.png').write_bytes(b'GH_TOKEN=ghs_fake\0')
            os.symlink('/etc/hosts', out / 'shots/link__app__desktop.png')
            outside = Path(tmp) / 'elsewhere.png'
            outside.write_bytes(self.PNG)
            good = self.trusted(out, '/anything/home__app__desktop.png')
            self.assertEqual(good.returncode, 0)
            self.assertEqual(Path(good.stdout).resolve(), (out / 'shots/home__app__desktop.png').resolve())
            for bad in ('/proc/self/environ', str(out / 'shots/env__app__desktop.png'),
                        str(out / 'shots/link__app__desktop.png'), str(outside), '../../etc/passwd.png'):
                result = self.trusted(out, bad)
                self.assertNotEqual(result.returncode, 0, bad)
                self.assertEqual(result.stdout, '', bad)


if __name__ == '__main__':
    unittest.main()
