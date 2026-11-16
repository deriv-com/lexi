"""Exercise redact-output.mjs, which scrubs credentials from reports and uploaded artifacts."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from urllib.parse import quote

TOOLS = Path(__file__).resolve().parents[1]
REDACT = str(TOOLS / 'redact-output.mjs')

# Token shapes are assembled at run time so the repository's own leak scan
# never sees one in this file.
def shaped(prefix, body='A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8'):
    return prefix + body

GITHUB_TOKENS = [shaped(p + '_') for p in ('ghs', 'ghp', 'gho', 'ghu', 'ghr')] + [shaped('github' + '_pat_11', '_' + 'Ab9' * 12)]
MODEL_KEY = shaped('s' + 'k-ant-api03-')
SLACK_TOKEN = shaped('xo' + 'xb-123456-')
PEM_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
PEM_FOOTER = '-----END ' + 'RSA PRIVATE KEY-----'
PEM = PEM_HEADER + '\nMIIEowIBAAKCAQEAfakefakefake\nZm9vYmFyYmF6\n' + PEM_FOOTER
WEBHOOK = 'https://hooks.slack.com/' + 'services/T0TEST01/B0TEST01/abcdefghijklmnop'

# Values that are not token-shaped: only redaction by value catches them.
SECRETS = {
    'GH_TOKEN': 'gateway "token"/with=odd&chars plus space',
    'ANTHROPIC_AUTH_TOKEN': 'model-gateway-credential-0001',
    'CF_ACCESS_CLIENT_SECRET': 'access proxy secret value',
    'LEXI_REDACT_TURNSTILE': 'Mozilla/5.0 bypass-agent',
}


def forms(value):
    once = json.dumps(value)[1:-1]
    return {'raw': value, 'json': once, 'json-in-json': json.dumps(once)[1:-1],
            'url': quote(value, safe="-_.!~*'()"), 'form': quote(value, safe='-_.*').replace('%20', '+')}


def run(*args, text='', env=None):
    return subprocess.run(['node', REDACT, *args], input=text, text=True, capture_output=True,
                          env=dict(os.environ, **(env or {})))


class RedactValuesTest(unittest.TestCase):
    def test_every_form_of_every_secret_is_removed_from_a_file(self):
        for name, value in SECRETS.items():
            for label, form in forms(value).items():
                with self.subTest(secret=name, form=label), tempfile.TemporaryDirectory() as tmp:
                    f = Path(tmp, 'segment-1.jsonl')
                    f.write_text(f'before {form} after\n')
                    result = run('--files', str(f), env=SECRETS)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    out = f.read_text()
                    self.assertNotIn(form, out)
                    self.assertEqual(out, 'before [redacted] after\n')
                    self.assertNotIn(form, result.stderr)

    def test_a_credential_named_by_its_variable_is_redacted_without_being_listed(self):
        result = run(text='key=proxy-client-secret-value', env={'SOME_VENDOR_CLIENT_SECRET': 'proxy-client-secret-value'})
        self.assertEqual(result.stdout, 'key=[redacted]')

    def test_a_very_short_value_is_skipped_and_named(self):
        result = run(text='abc and abc', env={'ODD_TOKEN': 'abc'})
        self.assertEqual(result.stdout, 'abc and abc')
        self.assertIn('ODD_TOKEN', result.stderr)

    def test_find_reports_values_but_not_mere_token_shapes(self):
        clean = run('--find', text='const t = "' + GITHUB_TOKENS[0] + '"', env=SECRETS)
        self.assertEqual((clean.returncode, clean.stdout), (0, ''))
        hit = run('--find', text='x ' + forms(SECRETS['GH_TOKEN'])['url'], env=SECRETS)
        self.assertEqual((hit.returncode, hit.stdout), (1, 'GH_TOKEN\n'))


class RedactShapesTest(unittest.TestCase):
    def assertScrubbed(self, secret, text=None):
        text = text if text is not None else f'a {secret} b'
        result = run(text=text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(secret, result.stdout)
        self.assertIn('[redacted]', result.stdout)
        return result.stdout

    def test_github_tokens(self):
        for token in GITHUB_TOKENS:
            with self.subTest(token=token[:4]):
                self.assertEqual(self.assertScrubbed(token), 'a [redacted] b')

    def test_model_and_slack_tokens(self):
        self.assertScrubbed(MODEL_KEY)
        self.assertScrubbed(SLACK_TOKEN)

    def test_private_key_raw_json_escaped_url_encoded_and_cut_off(self):
        self.assertEqual(self.assertScrubbed(PEM), 'a [redacted] b')
        escaped = json.dumps({'key': PEM})
        out = self.assertScrubbed('MIIEowIBAAKCAQEA', escaped)
        self.assertEqual(json.loads(out), {'key': '[redacted]'})
        self.assertScrubbed('MIIEowIBAAKCAQEA', quote(PEM))
        self.assertScrubbed('MIIEowIBAAKCAQEA', PEM_HEADER + '\nMIIEowIBAAKCAQEAfake')

    def test_slack_webhook_raw_and_encoded(self):
        self.assertScrubbed('abcdefghijklmnop', WEBHOOK)
        self.assertScrubbed('abcdefghijklmnop', quote(WEBHOOK, safe=''))

    def test_bearer_header_and_url_credentials_keep_their_context(self):
        out = self.assertScrubbed('opaque-session-value-0123456789', 'Authorization: Bearer opaque-session-value-0123456789')
        self.assertEqual(out, 'Authorization: Bearer [redacted]')
        url = 'https://' + 'x-access-token' + ':' + 'not-a-real-token' + '@github.com/acme/app.git'
        out = self.assertScrubbed('not-a-real-token', 'git push ' + url)
        self.assertEqual(out, 'git push https://[redacted]@github.com/acme/app.git')

    def test_a_jsonl_transcript_stays_valid_json(self):
        line = json.dumps({'type': 'tool_result', 'content': f'token {GITHUB_TOKENS[0]} and {SECRETS["GH_TOKEN"]}'})
        result = run(text=line, env=SECRETS)
        self.assertEqual(json.loads(result.stdout), {'type': 'tool_result', 'content': 'token [redacted] and [redacted]'})

    def test_ordinary_text_is_untouched(self):
        text = 'ask-a-question, task-runner-output, https://example.test/path, Bearer short'
        self.assertEqual(run(text=text).stdout, text)


class RedactFilesTest(unittest.TestCase):
    def test_directories_binaries_symlinks_and_missing_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp, 'upload')
            (root / 'nested').mkdir(parents=True)
            text = root / 'nested' / 'notes.md'
            text.write_text('see ' + GITHUB_TOKENS[0])
            leaky = root / 'trace.bin'
            leaky.write_bytes(b'\x00\x01' + SECRETS['ANTHROPIC_AUTH_TOKEN'].encode() + b'\x00')
            clean = root / 'shot.png'
            clean.write_bytes(b'\x89PNG\x00\x00 nothing here')
            outside = Path(tmp, 'outside.txt')
            outside.write_text(GITHUB_TOKENS[1])
            (root / 'link').symlink_to(outside)
            result = run('--files', str(root), str(Path(tmp, 'missing-*.jsonl')), env=SECRETS)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(text.read_text(), 'see [redacted]')
            self.assertFalse(leaky.exists())
            self.assertTrue(clean.exists())
            self.assertFalse((root / 'link').exists() or (root / 'link').is_symlink())
            self.assertEqual(outside.read_text(), GITHUB_TOKENS[1], 'a symlink target outside the upload is never written')

    def test_an_entry_named_after_a_credential_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp, 'assets')
            root.mkdir()
            (root / ('login-' + quote(SECRETS['ANTHROPIC_AUTH_TOKEN']) + '.png')).write_bytes(b'\x89PNG\x00')
            (root / 'home.png').write_bytes(b'\x89PNG\x00')
            result = run('--files', str(root), env=SECRETS)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['home.png'])
            self.assertNotIn(SECRETS['ANTHROPIC_AUTH_TOKEN'], result.stderr)

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root reads any file')
    def test_an_unreadable_file_fails_so_the_caller_does_not_upload(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp, 'segment-1.jsonl')
            f.write_text('x')
            f.chmod(0)
            try:
                result = run('--files', str(f))
            finally:
                f.chmod(0o600)
            self.assertEqual(result.returncode, 1)
            self.assertIn('::error::redact-output', result.stderr)


if __name__ == '__main__':
    unittest.main()
