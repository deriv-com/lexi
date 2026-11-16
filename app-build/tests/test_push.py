"""Exercise the push-time credential scan without contacting GitHub."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from urllib.parse import quote

TOOLS = Path(__file__).resolve().parents[1]
SECRET = 'fake "pass"/word for=push-test'


class PushScanTest(unittest.TestCase):
    def test_encoded_credentials_block_the_push(self):
        forms = {'raw': SECRET, 'json': json.dumps(SECRET)[1:-1],
                 'url': quote(SECRET, safe="-_.!~*'()"), 'form': quote(SECRET, safe='-_.*').replace('%20', '+')}
        for label, form in forms.items():
            with self.subTest(form=label), tempfile.TemporaryDirectory() as tmp:
                repo, runner = Path(tmp, 'repo'), Path(tmp, 'runner')
                repo.mkdir()
                runner.mkdir()
                git = lambda *args: subprocess.check_output(['git', '-c', 'user.name=T', '-c', 'user.email=t@example.test',
                                                             '-c', 'commit.gpgsign=false', *args], cwd=repo, text=True)
                git('init', '-q')
                git('commit', '-q', '--allow-empty', '-m', 'seed')
                (runner / 'start-sha').write_text(git('rev-parse', 'HEAD').strip())
                (repo / 'notes.txt').write_text(f'login {form}\n')
                git('add', '.')
                git('commit', '-qm', 'notes')
                env = dict(os.environ, RUNNER_TEMP=str(runner), GITHUB_WORKSPACE=str(repo),
                           STAGING_REAL_PASSWORD=SECRET, LEXI_APP='web', LEXI_SESSION='1')
                result = subprocess.run(['bash', str(TOOLS / 'push.sh'), 'end'], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('Refusing to push: a commit in this session contains a form of STAGING_REAL_PASSWORD',
                              result.stdout)
                self.assertNotIn(form, result.stdout + result.stderr)

    def test_find_mode_passes_clean_text(self):
        result = subprocess.run(['node', str(TOOLS / 'redact-output.mjs'), '--find'], input='nothing sensitive',
                                text=True, capture_output=True, env=dict(os.environ, STAGING_REAL_PASSWORD=SECRET))
        self.assertEqual((result.returncode, result.stdout), (0, ''))


if __name__ == '__main__':
    unittest.main()
