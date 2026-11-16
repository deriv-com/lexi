"""Feedback delivery: prompt transport, the transactional cursor, bounded
batches, replay. Runs feedback.sh, segment.sh, feedback-cursor.sh and
report.sh against a local gh double and a stub claude (feedback_harness.py)."""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest

from feedback_harness import (DOCS, TOOLS, Workspace, at, comment, git, make_comments)

ROOT = TOOLS.parent
WORKFLOW = ROOT / '.github/workflows/app-build.yml'
PAUSED = '_Feedback delivery is paused for this session: the feedback cursor could not be saved._'
UNREADABLE = "_The PR's comments could not be read this segment; nothing is skipped._"
NOT_PREPARED = '_Feedback could not be prepared for this segment; nothing is skipped._'
IQA = 'qa-bot[bot]'
LEXI = 'lexi-github-app[bot]'


def keys(items):
    return [f'comment:{c["id"]}' for c in items]


def snapshot(w, name='snap'):
    """Copy the current batch files the way segment.sh does at render time."""
    d = w.root / f'{name}-{w.session}-{time.time_ns()}'
    d.mkdir()
    shutil.copy(w.rt / 'feedback/batch.json', d / 'batch.json')
    shutil.copy(w.rt / 'feedback/pending.json', d / 'pending.json')
    return d


def drain(w, **env):
    """Deliver every batch by committing each prepared snapshot; return the batches."""
    batches = []
    for _ in range(50):
        w.run_feedback(**env)
        b = w.batch()
        if b is None:
            return batches
        b['_markdown'] = (w.rt / 'feedback.md').read_text()
        batches.append(b)
        w.run_cursor('commit', str(len(batches)), str(snapshot(w)))
    raise AssertionError('feedback never drained')


def decide_snippet():
    """The `run: |` block of the decide step, dedented (no YAML parser needed)."""
    lines = WORKFLOW.read_text().splitlines()
    start = next(i for i, l in enumerate(lines) if l.strip() == '- name: Decide whether the next session runs')
    indent = len(lines[start]) - len(lines[start].lstrip())
    run = next(i for i in range(start, len(lines)) if lines[i].strip() == 'run: |')
    body = []
    for l in lines[run + 1:]:
        if l.strip() and len(l) - len(l.lstrip()) <= indent:
            break
        body.append(l)
    return textwrap.dedent('\n'.join(body))


def run_decide(w, **extra):
    out, envf, summary = w.root / 'gh-output', w.root / 'gh-env', w.root / 'gh-summary'
    for f in (out, envf, summary):
        f.write_text('')
    env = dict(os.environ, GITHUB_OUTPUT=str(out), GITHUB_ENV=str(envf), GITHUB_STEP_SUMMARY=str(summary),
               RUNNER_TEMP=str(w.rt), LEXI_DOCS_DIR=DOCS, LEXI_PHASES='false', LEXI_SESSION='1',
               LEXI_MAX_SESSIONS='30', ASSESS_EVERY='1', PUSH_OUTCOME='success', **extra)
    result = subprocess.run(['bash', '-c', decide_snippet()], cwd=w.ws, env=env, capture_output=True, text=True)
    return result, dict(l.split('=', 1) for l in out.read_text().splitlines() if '=' in l), envf.read_text()


class RenderPromptTest(unittest.TestCase):
    def test_render_prompt_reads_file_placeholders(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 't.md').write_text('A __FEEDBACK__ B __LABEL__ C __MISSING__')
            value = 'Ünïcödé ✓ $& $1 \\ back\\slash\n- **x**'
            (root / 'f.md').write_text(value)
            env = dict(os.environ, PROMPT_FEEDBACK='from env', PROMPT_FEEDBACK_FILE=str(root / 'f.md'),
                       PROMPT_LABEL='label')
            r = subprocess.run(['node', str(TOOLS / 'render-prompt.mjs'), str(root / 't.md'), str(root / 'o.md')],
                               env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((root / 'o.md').read_text(), f'A {value} B label C __MISSING__')
            env['PROMPT_FEEDBACK_FILE'] = str(root / 'absent.md')
            r = subprocess.run(['node', str(TOOLS / 'render-prompt.mjs'), str(root / 't.md'), str(root / 'o2.md')],
                               env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn('PROMPT_FEEDBACK_FILE', r.stderr)
            self.assertNotIn('absent.md', r.stderr)
            self.assertFalse((root / 'o2.md').exists())


class StaticTest(unittest.TestCase):
    def test_no_argv_prompt_left(self):
        for script in TOOLS.glob('*.sh'):
            self.assertNotIn('claude -p "$(', script.read_text(), script.name)
        text = WORKFLOW.read_text()
        for n in (1, 2, 3):
            # exec, from a verified copy of the sealed tools.
            self.assertIn(f'exec /bin/bash "${{RUNNER_TEMP}}/app-build/segment.sh" {n}\n', text)
        self.assertNotRegex(text, r"run: '\"\$RUNNER_TEMP/app-build/segment.sh\"")

    def test_workflow_wiring(self):
        text = WORKFLOW.read_text()
        m = re.search(r'\n      replay_from_comment:\n(.*?)\n      [a-z_]+:\n|\n      replay_from_comment:\n(.*?)\n    outputs:',
                      text, re.S)
        self.assertIsNotNone(m, 'replay_from_comment input')
        block = m.group(1) or m.group(2)
        self.assertIn('required: false', block)
        self.assertIn('default: ""', block)
        steps = re.split(r'\n      - (?:name|uses): ', text)
        ctx = [s for s in steps if s.startswith('Read feedback from the PR')]
        self.assertEqual(len(ctx), 1)
        self.assertIn('LEXI_FEEDBACK_REPLAY_INPUT: ${{ inputs.replay_from_comment }}', ctx[0])
        self.assertIn('LEXI_FEEDBACK_REPLAY_VAR: ${{ vars.LEXI_FEEDBACK_REPLAY_FROM }}', ctx[0])
        refresh = [s for s in steps if s.startswith('Push and refresh feedback')]
        self.assertEqual(len(refresh), 2)
        for s in refresh + ctx:
            self.assertIn('LEXI_FEEDBACK_BATCH_BYTES: ${{ vars.LEXI_FEEDBACK_BATCH_BYTES }}', s)
            self.assertIn('LEXI_FEEDBACK_BATCH_TOKENS: ${{ vars.LEXI_FEEDBACK_BATCH_TOKENS }}', s)
        for s in refresh:
            self.assertNotIn('REPLAY', s)
            self.assertIn('|| PUSH_RC=$?', s)
        self.assertEqual(text.count('LEXI_FEEDBACK_REPLAY_INPUT'), 1)
        nxt = text[text.index('\n  next:'):text.index('\n  assess:')]
        self.assertNotIn('replay', nxt)
        report = [s for s in steps if s.startswith('Post the session report')][0]
        self.assertIn('PUSH_OUTCOME: ${{ steps.final-push.outcome }}', report)


class CursorUnitTest(unittest.TestCase):
    def items_file(self, w, items):
        f = w.root / f'items-{time.time_ns()}.json'
        f.write_text(json.dumps(items))
        return str(f)

    def test_valid_branch_cursor_copied_byte_for_byte(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        raw = ('{ "version":1,  "rev": 3, "pr": 27,\n "floor": "2026-10-01T00:00:00Z", "watermark":"2026-10-02T00:00:00Z",'
               '"safe_at": "2026-10-02T00:00:00Z", "delivered": [], "replay": null, "replay_done": [], "updated": null }\n')
        w.branch_cursor_path().write_text(raw)
        w.run_feedback()
        self.assertEqual((w.rt / 'feedback-cursor.json').read_text(), raw)
        self.assertTrue((w.rt / 'feedback-cursor-tracked').exists())
        self.assertEqual(w.batch()['cursor_rev'], 3)
        before = w.branch_cursor_path().stat().st_mtime_ns
        w.run_cursor('restore')
        self.assertEqual(w.branch_cursor_path().read_text(), raw)
        self.assertEqual(w.branch_cursor_path().stat().st_mtime_ns, before)
        # A builder's edit is undone.
        w.branch_cursor_path().write_text('{"version": 1}')
        r = w.run_cursor('restore')
        self.assertIn('restored', r.stdout)
        self.assertEqual(w.branch_cursor_path().read_text(), raw)

    def test_invalid_or_foreign_branch_cursor_falls_back_to_legacy(self):
        for name, text in (('invalid', '{"version": 2}'), ('other_pr', json.dumps({
                'version': 1, 'rev': 1, 'pr': 99, 'floor': '2026-10-01T00:00:00Z', 'watermark': '2026-10-01T00:00:00Z',
                'safe_at': '2026-10-01T00:00:00Z', 'delivered': [], 'replay': None, 'replay_done': []})),
                ('bad_key', json.dumps({
                'version': 1, 'rev': 1, 'pr': 27, 'floor': '2026-10-01T00:00:00Z', 'watermark': '2026-10-01T00:00:00Z',
                'safe_at': '2026-10-01T00:00:00Z', 'delivered': [{'key': '../x', 'at': '2026-10-01T00:00:00Z'}],
                'replay': None, 'replay_done': []}))):
            with self.subTest(name):
                w = Workspace(self, comments=[comment(1, at(0))])
                w.branch_cursor_path().write_text(text)
                r = w.run_feedback()
                cur = w.read_cursor()
                self.assertEqual(cur['rev'], 0)
                self.assertEqual(cur['floor'], '1970-01-01T00:00:00Z')
                self.assertFalse((w.rt / 'feedback-cursor-tracked').exists())
                self.assertEqual(w.branch_cursor_path().read_text(), text, 'legacy init does not touch the branch file')
                if name != 'other_pr':
                    self.assertIn('::warning::', r.stdout)

    def test_commit_rejects_missing_pending(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.run_feedback()
        snap = snapshot(w)
        (snap / 'pending.json').unlink()
        before = (w.rt / 'feedback-cursor.json').read_bytes()
        r = w.run_cursor('commit', '1', str(snap), check_rc=2)
        self.assertIn('snapshot', r.stderr)
        self.assertEqual((w.rt / 'feedback-cursor.json').read_bytes(), before)
        self.assertFalse(w.branch_cursor_path().exists())
        # A batch key that is not in the pending list is refused too.
        snap = snapshot(w)
        (snap / 'pending.json').write_text('[]')
        w.run_cursor('commit', '1', str(snap), check_rc=2)
        self.assertFalse(w.branch_cursor_path().exists())

    def test_commit_refuses_a_stale_snapshot(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.run_feedback()
        snap = snapshot(w)
        b = json.loads((snap / 'batch.json').read_text())
        b['cursor_rev'] = 5
        (snap / 'batch.json').write_text(json.dumps(b))
        before = (w.rt / 'feedback-cursor.json').read_bytes()
        r = w.run_cursor('commit', '1', str(snap), check_rc=2)
        self.assertIn('cursor changed since this batch was prepared (rev 0 != 5)', r.stderr)
        self.assertEqual((w.rt / 'feedback-cursor.json').read_bytes(), before)
        self.assertFalse(w.branch_cursor_path().exists())
        # The same snapshot cannot be committed twice.
        snap = snapshot(w)
        w.run_cursor('commit', '1', str(snap))
        w.run_cursor('commit', '1', str(snap), check_rc=2)
        self.assertEqual(w.read_cursor()['rev'], 1)

    def test_floor_and_safe_at_are_monotonic_and_delivered_is_pruned(self):
        old = [comment(i, at(i, base='2026-10-01T00:00:00Z')) for i in range(1, 3)]
        new = [comment(i, at(i, base='2026-10-12T00:00:00Z')) for i in range(3, 5)]
        w = Workspace(self, comments=old + new)
        w.run_feedback(LEXI_FEEDBACK_BATCH_BYTES='4096')
        b = w.batch()
        self.assertEqual(b['keys'], keys(old + new))
        w.run_cursor('commit', '1', str(snapshot(w)))
        cur = w.read_cursor()
        self.assertEqual(cur['watermark'], new[-1]['created_at'])
        self.assertEqual(cur['floor'], '2026-10-05T00:04:00Z', 'watermark - 7 days')
        self.assertEqual(cur['safe_at'], cur['watermark'])
        self.assertEqual([d['key'] for d in cur['delivered']], keys(new), 'pruned to at > floor')
        self.assertEqual(cur, w.branch_cursor())
        # A later batch with pending items left keeps floor and safe_at below them, never lower than before.
        later = [comment(i, at(i, base='2026-10-13T00:00:00Z'), body='x' * 1800 + f' MARK-{i}-END') for i in range(5, 9)]
        w.add_comments(later)
        w.run_feedback(LEXI_FEEDBACK_BATCH_BYTES='4096')
        b = w.batch()
        self.assertEqual(b['keys'], keys(later[:2]))
        w.run_cursor('commit', '2', str(snapshot(w)))
        cur2 = w.read_cursor()
        self.assertEqual(cur2['safe_at'], '2026-10-13T00:06:59Z', 'earliest remaining - 1 s')
        self.assertGreaterEqual(cur2['floor'], cur['floor'])
        self.assertGreaterEqual(cur2['safe_at'], cur['safe_at'])
        self.assertEqual(cur2['rev'], 2)
        self.assertEqual(w.run_cursor('safe-at').stdout.strip(), '2026-10-13T00:06:59Z')
        self.assertEqual((w.rt / 'feedback-pending').read_text().strip(), '2')

    def test_safe_at_states(self):
        w = Workspace(self)
        self.assertEqual(w.run_cursor('safe-at').stdout, '', 'nothing when the session start failed')
        (w.rt / 'feedback-safe-at-start').write_text('2026-10-01T00:00:00Z')
        (w.rt / 'feedback-cursor.json').write_text(json.dumps({'safe_at': '2026-10-09T00:00:00Z'}))
        self.assertEqual(w.run_cursor('safe-at').stdout.strip(), '2026-10-01T00:00:00Z', 'untracked: the start value')
        (w.rt / 'feedback-cursor-tracked').touch()
        self.assertEqual(w.run_cursor('safe-at').stdout.strip(), '2026-10-09T00:00:00Z')


class FeedbackBatchTest(unittest.TestCase):
    def test_backlog_splits_into_bounded_ordered_batches(self):
        items = make_comments(30, 4500)
        for name, env, limit_b, limit_t in (('bytes bind', {}, 30000, 10000),
                                            ('tokens bind', {'LEXI_FEEDBACK_BATCH_BYTES': '60000',
                                                             'LEXI_FEEDBACK_BATCH_TOKENS': '5000'}, 15000, 5000)):
            with self.subTest(name):
                w = Workspace(self, comments=items)
                batches = drain(w, **env)
                self.assertGreater(len(batches), 1)
                seen = []
                for b in batches:
                    self.assertLessEqual(b['bytes'], limit_b)
                    self.assertLessEqual(b['tokens_est'], limit_t)
                    self.assertEqual(b['bytes'], sum(i['bytes'] for i in b['items']))
                    self.assertFalse(b['oversized'])
                    seen += b['keys']
                    # Each comment is in its batch whole.
                    for c in items:
                        if f'comment:{c["id"]}' in b['keys']:
                            self.assertIn(c['body'], b['_markdown'])
                self.assertEqual(seen, keys(items), 'chronological, each exactly once')
                self.assertTrue(batches[0]['_markdown'].startswith(f'_Feedback batch 1 of {len(batches)}: '))

    def test_duplicate_ids_delivered_once(self):
        c = comment(1, at(0))
        w = Workspace(self, comments=[c, dict(c), comment(2, at(1))])
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], ['comment:1', 'comment:2'])
        self.assertEqual((w.rt / 'feedback.md').read_text().count('MARK-1-END'), 1)

    def test_identical_text_distinct_comments_kept(self):
        w = Workspace(self, comments=[comment(1, at(0), body='+1 same text'), comment(2, at(0), body='+1 same text')])
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], ['comment:1', 'comment:2'])
        self.assertEqual((w.rt / 'feedback.md').read_text().count('+1 same text'), 2)

    def test_iqa_bot_is_eligible_and_unnamed_bots_are_not(self):
        w = Workspace(self, authors=f'*,{LEXI},{IQA}', comments=[
            comment(6173802225, at(0), who=IQA, body='iqa QA result: Home, CFDs MARK-6173802225-END'),
            comment(2, at(1), who='gh-app-write[bot]'),
            comment(3, at(2), who='bob'),
        ])
        r = w.run_feedback()
        self.assertEqual(w.batch()['keys'], ['comment:6173802225', 'comment:3'])
        self.assertIn('1 from anyone else ignored', r.stdout)
        self.assertIn(f'- **{IQA}** ({at(0)}, comment): iqa QA result: Home, CFDs', (w.rt / 'feedback.md').read_text())

    def test_reports_and_assessments_are_not_feedback(self):
        w = Workspace(self, authors=f'alice,{LEXI}', comments=[
            comment(1, at(0), who=LEXI, body='<!-- app-build:report -->\nsession report'),
            comment(2, at(1), who=LEXI, body='<!-- app-build:assessment app=web -->\nassessment'),
            comment(3, at(2), who=LEXI, body='**Parity metrics** MARK-3-END'),
        ])
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], ['comment:3'])

    def test_empty_pending_writes_empty_feedback(self):
        w = Workspace(self)
        w.run_feedback()
        self.assertEqual((w.rt / 'feedback.md').read_text(), '')
        self.assertIsNone(w.batch())
        self.assertFalse((w.rt / 'feedback/pending.json').exists())
        self.assertEqual((w.rt / 'feedback-pending').read_text(), '0')

    def test_init_or_partition_failure_writes_no_batch(self):
        with self.subTest('init'):
            w = Workspace(self, comments=[comment(1, at(0))])
            (w.rt / 'feedback-cursor.json').mkdir()
            r = w.run_feedback()
            self.assertIn('::error::Feedback cursor could not be loaded', r.stdout)
            self.assertEqual((w.rt / 'feedback.md').read_text(),
                             '_The feedback cursor could not be loaded this segment; nothing is skipped._\n')
            self.assertIsNone(w.batch())
            self.assertFalse((w.rt / 'feedback/pending.json').exists())
            self.assertFalse(w.branch_cursor_path().exists())
        with self.subTest('partition'):
            bad = comment(2, at(1))
            bad['body'] = 12345
            w = Workspace(self, comments=[comment(1, at(0)), bad])
            r = w.run_feedback()
            self.assertIn('::error::Feedback could not be prepared', r.stdout)
            self.assertEqual((w.rt / 'feedback.md').read_text(), NOT_PREPARED + '\n')
            self.assertIsNone(w.batch())
            self.assertFalse((w.rt / 'feedback/pending.json').exists())
            self.assertEqual(list((w.ws / '.lexi-feedback').glob('ref-*')), [])
            self.assertFalse(w.branch_cursor_path().exists())

    def test_batch_limit_counts_entries_only(self):
        prefix = f'- **alice** ({at(0)}, comment): '
        sizes = 4096 // 2
        bodies = ['a' * (sizes - len(prefix) - 1), 'b' * (sizes - len(prefix) - 1)]
        w = Workspace(self, comments=[comment(1, at(0), body=bodies[0]), comment(2, at(0), body=bodies[1])])
        w.run_feedback(LEXI_FEEDBACK_BATCH_BYTES='4096')
        b = w.batch()
        self.assertEqual(b['bytes'], 4096)
        self.assertEqual(b['keys'], ['comment:1', 'comment:2'])
        self.assertGreater((w.rt / 'feedback.md').stat().st_size, 4096)

    def test_invalid_limits_use_the_defaults(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        r = w.run_feedback(LEXI_FEEDBACK_BATCH_BYTES='12', LEXI_FEEDBACK_BATCH_TOKENS='lots')
        self.assertIn('::warning::LEXI_FEEDBACK_BATCH_BYTES must be a whole number', r.stderr + r.stdout)
        self.assertIn('≤30000 bytes, ≤10000 tokens', r.stdout)

    def test_oversized_comment_written_by_reference(self):
        big = 'Big comment MARK-1-END\r\n' + ('line of text ✓\r\n' * 400)
        with self.subTest('issue comment'):
            w = Workspace(self, comments=[comment(1, at(0), body=big), comment(2, at(1))])
            r = w.run_feedback(LEXI_FEEDBACK_BATCH_BYTES='4096')
            b = w.batch()
            self.assertEqual(b['keys'], ['comment:1'])
            self.assertTrue(b['oversized'])
            ref = w.ws / '.lexi-feedback/ref-comment-1.md'
            self.assertEqual(b['items'][0]['ref'], str(ref))
            self.assertEqual(ref.read_bytes(), big.encode(), 'exact body, \\r kept')
            self.assertFalse((w.ws / '.lexi-feedback/ref-comment-1.folded.md').exists())
            md = (w.rt / 'feedback.md').read_text()
            self.assertIn(f'Read it in full from `{ref}`', md)
            self.assertNotIn('line of text', md)
            self.assertRegex(r.stdout, r'::warning::Feedback comment:1 by alice is \d+ bytes \(limit 4096\); '
                                       r'delivered alone by reference\.')
            self.assertIn('/.lexi-feedback/', (w.ws / '.git/info/exclude').read_text().splitlines())
            self.assertEqual(git(w.ws, 'status', '--porcelain'), '')
        with self.subTest('inline comment'):
            inline = comment(7, at(0), kind='inline', body=big, path='src/page.tsx')
            w = Workspace(self, inline=[inline])
            w.run_feedback(LEXI_FEEDBACK_BATCH_BYTES='4096')
            ref = w.ws / '.lexi-feedback/ref-inline-7.md'
            self.assertEqual(w.batch()['keys'], ['inline:7'])
            self.assertEqual(ref.read_bytes(), ('On `src/page.tsx`: ' + big).encode())
        with self.subTest('long line'):
            line = ('0123456789' * 999) + 'ü'
            body = 'Header MARK-1-END\n' + line + '\n' + ('short line\n' * 6000)
            self.assertGreater(len(body.encode()), 70000)
            w = Workspace(self, comments=[comment(1, at(0), body=body)])
            r = w.run_feedback()
            exact = w.ws / '.lexi-feedback/ref-comment-1.md'
            folded = w.ws / '.lexi-feedback/ref-comment-1.folded.md'
            self.assertEqual(exact.read_text(), body)
            ftext = folded.read_text()
            self.assertTrue(all(len(l) <= 1902 for l in ftext.split('\n')))
            rejoined = []
            for l in ftext.split('\n'):
                if l.startswith('↳ '):
                    rejoined[-1] += l[2:]
                else:
                    rejoined.append(l)
            self.assertEqual('\n'.join(rejoined), body)
            b = w.batch()
            self.assertEqual(b['items'][0]['ref'], str(folded))
            md = (w.rt / 'feedback.md').read_text()
            self.assertIn(f'Read it in full from `{folded}`', md)
            self.assertIn(f'The exact text is in `{exact}`', md)
            self.assertIn(f'folded for reading (longest line {len(line)} chars)', r.stdout)

    def test_fetch_failure_writes_note_and_no_batch(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        r = w.run_feedback(GH_FAIL='pulls/27/reviews')
        self.assertIn("::warning::The PR's comments could not be read", r.stdout)
        self.assertEqual((w.rt / 'feedback.md').read_text(), UNREADABLE + '\n')
        self.assertIsNone(w.batch())
        self.assertFalse((w.rt / 'feedback-cursor.json').exists())

    def test_legacy_fallback_unchanged_for_old_reports(self):
        reports = [comment(10, at(0), who=LEXI, body='<!-- app-build:report -->\nold 1'),
                   comment(11, at(5), who=LEXI, body='<!-- app-build:report -->\nold 2'),
                   comment(12, at(9), who=LEXI, body='<!-- app-build:report -->\nold 3')]
        w = Workspace(self, comments=reports + [comment(1, at(3)), comment(2, at(7))])
        w.run_feedback()
        self.assertEqual(w.read_cursor()['floor'], at(5), 'second-latest report')
        self.assertEqual(w.batch()['keys'], ['comment:2'])
        # New-version reports (v1 marker, no read-at marker) never move that fallback.
        w2 = Workspace(self, comments=[comment(1, at(3))] + [
            comment(20 + i, at(5 + i), who=LEXI, body='<!-- app-build:report -->\n<!-- app-build:feedback-cursor=v1 -->')
            for i in range(3)])
        w2.run_feedback()
        self.assertEqual(w2.read_cursor()['floor'], '1970-01-01T00:00:00Z')
        self.assertEqual(w2.batch()['keys'], ['comment:1'])


class SegmentDeliveryTest(unittest.TestCase):
    def assertCursorUnchanged(self, w, rev=0):
        self.assertEqual(w.read_cursor()['rev'], rev)
        if rev == 0:
            self.assertFalse(w.branch_cursor_path().exists())
        self.assertFalse((w.rt / 'feedback-committed').exists())

    def test_large_backlog_starts_without_payload_in_argv(self):
        items = make_comments(40, 4500)
        total = sum(len(c['body'].encode()) for c in items)
        self.assertTrue(150_000 <= total <= 200_000, total)
        w = Workspace(self, comments=items)
        w.run_feedback()
        r = w.run_segment(1)
        self.assertEqual(w.calls(), 1, r.stdout)
        argv = w.argv(1)
        self.assertLess(sum(len(a.encode()) + 1 for a in argv), 8192)
        self.assertEqual(argv[0], '-p')
        self.assertFalse(any(a.startswith('You are') for a in argv))
        env = w.stub_env(1)
        self.assertFalse(env['body_in_env'])
        self.assertFalse(env['body_in_argv'])
        stdin = w.stdin(1)
        self.assertIn('_Feedback batch 1 of 7: 6 comment(s), ', stdin)
        committed = [d['key'] for d in w.read_cursor()['delivered']]
        self.assertEqual(w.delivered_keys(1), keys(items[:6]))
        self.assertEqual(committed, keys(items[:6]))
        self.assertNotIn(items[0]['body'][:60], r.stdout + r.stderr, 'no comment text in the log')

    def test_small_feedback_path_unchanged(self):
        w = Workspace(self, comments=[comment(1, at(0), body='Please make the header blue')])
        w.run_feedback()
        w.run_segment(1)
        stdin = w.stdin(1)
        self.assertIn(f'<feedback>\n_Feedback batch 1 of 1: 1 comment(s), ', stdin)
        self.assertIn(f'\n- **alice** ({at(0)}, comment): Please make the header blue\n</feedback>', stdin)
        self.assertNotRegex(stdin, r'__[A-Z_]+__')
        self.assertIn('FEEDBACK_CURSOR.json` is written by the workflow; never edit it.', stdin)
        self.assertEqual([d['key'] for d in w.read_cursor()['delivered']], ['comment:1'])
        self.assertEqual(w.exits(), ['1:0'])
        self.assertFalse((w.rt / 'prompt-inputs-1').exists(), 'temp inputs cleaned up')
        self.assertTrue((w.rt / 'prompt-segment-1.md').exists(), 'the prompt artifact is kept')
        self.assertIn('segment 1: 1 comment(s)', (w.rt / 'feedback-delivered.log').read_text())

    def test_successful_batch_advances_cursor(self):
        w = Workspace(self, comments=[comment(1, at(0)), comment(2, at(1))])
        w.run_feedback()
        self.assertIsNone(w.branch_cursor(), 'reading comments writes no cursor')
        w.run_segment(1)
        cur = w.read_cursor()
        self.assertEqual(cur['rev'], 1)
        self.assertEqual([d['key'] for d in cur['delivered']], ['comment:1', 'comment:2'])
        self.assertEqual(w.branch_cursor(), cur)
        self.assertIsNone(w.batch(), 'the consumed batch is not committed again')
        self.assertTrue((w.rt / 'feedback/batch-consumed-1.json').exists())
        self.assertEqual((w.rt / 'feedback-pending').read_text().strip(), '0')

    def test_launch_failure_keeps_cursor(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        (w.bin / 'claude').unlink()
        w.run_feedback()
        before = w.batch()
        r = w.run_segment(1)
        self.assertIn('was not processed', r.stdout)
        self.assertCursorUnchanged(w)
        self.assertEqual(w.batch(), before, 'batch kept for retry')
        self.assertEqual(w.exits(), ['1:127'])

    def test_nonzero_exit_keeps_cursor(self):
        for mode, exit_line in (('exit1', '1:1'), ('is_error', '1:0'), ('noinit', '1:noinit'), ('sigint130', '1:130')):
            with self.subTest(mode):
                w = Workspace(self, comments=[comment(1, at(0))])
                w.run_feedback()
                r = w.run_segment(1, STUB_CLAUDE_MODE=mode)
                self.assertEqual(w.exits(), [exit_line])
                self.assertCursorUnchanged(w)
                self.assertIsNotNone(w.batch())
                self.assertIn('::warning::Segment 1: feedback batch (1 comment(s), first comment:1) was not processed', r.stdout)
                if mode == 'noinit':
                    self.assertIn('::warning::Segment 1: the builder exited 0 without starting (no init event).', r.stdout)

    def test_render_failure_starts_no_builder(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.run_feedback()
        (w.rt / 'app-build/prompt-first.md').unlink()
        r = w.run_segment(1)
        self.assertIn('::error::Segment 1: the prompt could not be rendered.', r.stdout)
        self.assertEqual(w.calls(), 0)
        self.assertEqual(w.exits(), ['1:render-failed'])
        self.assertCursorUnchanged(w)

    def test_retry_delivers_same_comments(self):
        items = [comment(i, at(i)) for i in range(1, 4)]
        w = Workspace(self, comments=items)
        w.session_loop(segments=2, modes=['exit1', 'ok'])
        self.assertEqual(w.delivered_keys(1), keys(items))
        self.assertEqual(w.delivered_keys(2), keys(items))
        self.assertEqual([d['key'] for d in w.read_cursor()['delivered']], keys(items))

    def test_failure_after_first_batch_resumes_at_second(self):
        items = [comment(i, at(i), body=f'MARK-{i}-END ' + 'x' * 1500) for i in range(1, 7)]
        w = Workspace(self, comments=items)
        w.extra_env = {'LEXI_FEEDBACK_BATCH_BYTES': '4096'}
        w.session_loop(segments=2, modes=['ok', 'exit1'])
        self.assertEqual(w.delivered_keys(1), keys(items[0:2]))
        self.assertEqual(w.delivered_keys(2), keys(items[2:4]))
        self.assertEqual([d['key'] for d in w.branch_cursor()['delivered']], keys(items[0:2]))
        w.new_session()
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], keys(items[2:4]))
        self.assertTrue((w.rt / 'feedback.md').read_text().startswith('_Feedback batch 1 of 2: 2 comment(s)'))

    def test_every_comment_delivered_exactly_once(self):
        items = make_comments(24, 4500, multibyte=False)
        w = Workspace(self, comments=items)
        delivered = []
        w.session_loop(segments=2)
        delivered += w.delivered_keys(1) + w.delivered_keys(2)
        for _ in range(3):
            w.new_session()
            w.add_comments([comment(5000 + w.session, at(100 + w.session))])
            items.append(w.data()['comments'][-1])
            w.run_feedback()
            if w.batch() is None:
                break
            w.run_segment(1)
            delivered += w.delivered_keys(1)
        w.new_session()
        w.run_feedback()
        self.assertIsNone(w.batch())
        self.assertEqual(sorted(delivered), sorted(keys(items)))
        self.assertEqual(len(delivered), len(set(delivered)))

    def test_parity_comments_do_not_accumulate_across_sessions(self):
        def parity(cid, minute):
            return comment(cid, at(minute), who=LEXI,
                           body=f"**Parity metrics: production vs this app's preview** MARK-{cid}-END\n" + 'row | 1 | 2\n' * 800)
        w = Workspace(self, authors=f'*,{LEXI},{IQA}', comments=[parity(1, 0), parity(2, 360)])
        w.run_feedback()
        w.run_segment(1)
        self.assertEqual(w.delivered_keys(1), ['comment:1', 'comment:2'])
        for cid in (3, 4):
            w.new_session()
            w.add_comments([parity(cid, 360 * cid)])
            w.run_feedback()
            w.run_segment(1)
            self.assertEqual(w.delivered_keys(1), [f'comment:{cid}'], 'only the parity comment not delivered before')
            self.assertEqual(w.stdin(1).count('Parity metrics'), 1)

    def test_cursor_write_failure_is_surfaced(self):
        items = [comment(1, at(0)), comment(2, at(1))]
        w = Workspace(self, comments=items, docs_dir=False)
        (w.ws / 'app/web/docs').mkdir(parents=True)
        (w.ws / DOCS).write_text('not a directory')
        w.run_feedback()
        # The segment still exits 0, so the session's work is pushed; the error
        # file stops the loop.
        r = w.run_segment(1, check_rc=0)
        self.assertIn('::error::Segment 1: the feedback cursor could not be saved (', r.stdout)
        self.assertTrue((w.rt / 'feedback-cursor-error').exists())
        self.assertEqual(w.read_cursor()['rev'], 0)
        r = w.run_feedback()
        self.assertEqual((w.rt / 'feedback.md').read_text(), PAUSED + '\n')
        self.assertIsNone(w.batch())
        r = w.run_segment(2)
        stdin = w.stdin(2)
        self.assertIn(PAUSED, stdin)
        self.assertNotIn('MARK-', stdin)
        self.assertEqual(w.read_cursor()['rev'], 0, 'no commit attempted')
        # The report says so and publishes no advanced marker.
        (w.rt / 'pr-number').write_text('27')
        w.run_report(PUSH_OUTCOME='success')
        posted = (w.rt / 'posted.md').read_text()
        self.assertIn('the feedback cursor could not be saved', posted)
        self.assertIn('<!-- app-build:feedback-read-at=1970-01-01T00:00:00Z -->', posted)
        # The decide step stops the loop with that reason.
        _, out, genv = run_decide(w)
        self.assertEqual(out['continue'], 'false')
        self.assertIn('the feedback cursor could not be saved', genv)
        # The next session, with the docs dir repaired, delivers batch 1 again.
        (w.ws / DOCS).unlink()
        (w.ws / DOCS).mkdir()
        w.new_session()
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], keys(items))
        w.run_segment(1)
        self.assertEqual(w.branch_cursor()['rev'], 1)

    def test_deadline_with_work_counts_as_processed(self):
        for mode, committed in (('deadline', True), ('deadline_noassist', False)):
            with self.subTest(mode):
                w = Workspace(self, comments=[comment(1, at(0))])
                w.run_feedback()
                w.run_segment(1, STUB_CLAUDE_MODE=mode)
                self.assertEqual(w.exits(), ['1:124'])
                self.assertEqual(w.read_cursor()['rev'], 1 if committed else 0)

    def test_oversized_comment_delivered_alone_by_reference(self):
        big = 'Big MARK-1-END\n' + ('line ✓\n' * 900)
        for mode, fmt, committed in (('ok', None, False), ('ok_read_ref_error', None, False),
                                     ('ok_read_ref', None, True), ('ok_read_ref', 'odd', True)):
            with self.subTest(mode=mode, fmt=fmt):
                w = Workspace(self, comments=[comment(1, at(0), body=big), comment(2, at(1))])
                w.extra_env = {'LEXI_FEEDBACK_BATCH_BYTES': '4096'}
                w.run_feedback()
                r = w.run_segment(1, STUB_CLAUDE_MODE=mode, STUB_READ_PATH_FORMAT=fmt)
                self.assertEqual(w.read_cursor()['rev'], 1 if committed else 0)
                if committed:
                    self.assertEqual([d['key'] for d in w.read_cursor()['delivered']], ['comment:1'])
                else:
                    self.assertIn('::warning::Segment 1: the builder did not open the reference file for comment:1', r.stdout)
                self.assertNotIn('line ✓', w.stdin(1))
        with self.subTest('long line'):
            body = 'Header MARK-1-END\n' + 'z' * 10000 + '\n' + ('short line\n' * 6000)
            w = Workspace(self, comments=[comment(1, at(0), body=body)])
            w.run_feedback()
            folded = w.ws / '.lexi-feedback/ref-comment-1.folded.md'
            w.run_segment(1, STUB_CLAUDE_MODE='ok_read_ref')
            self.assertEqual(w.read_cursor()['rev'], 1, 'Read of the folded file counts')
            self.assertIn(str(folded), w.stdin(1))

    def test_oversized_ref_kept_until_committed(self):
        big = 'Big MARK-1-END\n' + ('line ✓\n' * 900)
        w = Workspace(self, comments=[comment(1, at(0), body=big)])
        w.extra_env = {'LEXI_FEEDBACK_BATCH_BYTES': '4096'}
        ref = w.ws / '.lexi-feedback/ref-comment-1.md'
        w.run_feedback()
        w.run_segment(1, STUB_CLAUDE_MODE='ok')
        self.assertTrue(ref.exists(), 'kept for the retry')
        w.run_feedback()
        w.run_segment(2, STUB_CLAUDE_MODE='ok_read_ref')
        self.assertEqual(w.read_cursor()['rev'], 1)
        self.assertFalse(ref.exists(), 'removed once committed')

    def test_fetch_failure_delivers_nothing_and_skips_nothing(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.run_feedback(GH_FAIL='issues/27/comments')
        w.run_segment(1)
        stdin = w.stdin(1)
        self.assertIn(UNREADABLE, stdin)
        self.assertNotIn('- **', stdin.split('<feedback>')[1].split('</feedback>')[0])
        self.assertFalse((w.rt / 'feedback-cursor.json').exists())
        w.run_feedback()
        w.run_segment(2)
        self.assertEqual(w.delivered_keys(2), ['comment:1'])

    def test_commit_uses_render_time_snapshot(self):
        with self.subTest('swap'):
            w = Workspace(self, comments=[comment(1, at(0)), comment(2, at(1))])
            w.run_feedback()
            p = w.start_segment(1, STUB_CLAUDE_MODE='swap')
            for _ in range(200):
                if (w.stub / 'waiting-1').exists():
                    break
                time.sleep(0.1)
            swapped = dict(w.batch(), keys=['comment:2'], items=[{'key': 'comment:2', 'at': at(1), 'who': 'alice', 'bytes': 1}])
            (w.rt / 'feedback/batch.json').write_text(json.dumps(swapped))
            (w.rt / 'feedback/pending.json').write_text(json.dumps([{'key': 'comment:2', 'at': at(1), 'normal': True, 'replay': False}]))
            (w.stub / 'go').touch()
            out, _ = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, out)
            self.assertEqual([d['key'] for d in w.read_cursor()['delivered']], ['comment:1', 'comment:2'])
            self.assertEqual(w.batch()['keys'], ['comment:2'], 'a different batch file is left alone')
        with self.subTest('size mismatch'):
            w = Workspace(self, comments=[comment(1, at(0))])
            w.run_feedback()
            with open(w.rt / 'feedback.md', 'a') as f:
                f.write('- **mallory** (x, comment): injected\n')
            r = w.run_segment(1)
            self.assertIn('::error::Segment 1: the feedback batch files do not match', r.stdout)
            self.assertIn(NOT_PREPARED, w.stdin(1))
            self.assertNotIn('injected', w.stdin(1))
            self.assertEqual(w.read_cursor()['rev'], 0)

    def test_docs_dir_created_on_fresh_branch(self):
        w = Workspace(self, comments=[comment(1, at(0))], docs_dir=False)
        w.run_feedback()
        w.run_segment(1)
        self.assertEqual(w.branch_cursor()['rev'], 1)
        self.assertFalse((w.rt / 'feedback-cursor-error').exists())

    def test_builder_edit_of_the_cursor_file_is_undone(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        w.run_feedback()
        w.run_segment(1)
        good = w.branch_cursor_path().read_text()
        w.add_comments([comment(2, at(1))])
        w.run_feedback()
        w.branch_cursor_path().write_text('{"version": 1, "floor": "2099-01-01T00:00:00Z"}')
        w.run_segment(2, STUB_CLAUDE_MODE='exit1')
        self.assertEqual(w.branch_cursor_path().read_text(), good)

    def test_signal_leaves_cursor(self):
        for mode in ('hang', 'hang_ignore', 'hang_child'):
            with self.subTest(mode):
                if mode == 'hang_child' and shutil.which('timeout') is None:
                    self.skipTest('needs GNU timeout (its own process group); runs on the ubuntu CI')
                w = Workspace(self, comments=[comment(1, at(0))])
                w.run_feedback()
                p = w.start_segment(1, STUB_CLAUDE_MODE=mode)
                for _ in range(300):
                    if (w.stub / 'running-1').exists():
                        break
                    time.sleep(0.1)
                self.assertTrue((w.stub / 'running-1').exists())
                pid = int((w.stub / 'pid-1').read_text())
                started = time.time()
                p.send_signal(signal.SIGTERM)
                out, _ = p.communicate(timeout=30)
                elapsed = time.time() - started
                self.assertEqual(p.returncode, 143, out)
                self.assertLess(elapsed, 9)
                self.assertIn('1:cancelled', w.exits())
                self.assertIn('::warning::Segment 1 was cancelled; the feedback cursor was not advanced.', out)
                pids = [pid] + ([int((w.stub / 'child-1').read_text())] if mode == 'hang_child' else [])
                for _ in range(20):
                    alive = [x for x in pids if self.alive(x)]
                    if not alive:
                        break
                    time.sleep(0.1)
                self.assertEqual(alive, [], 'the builder and its children are gone')
                self.assertCursorUnchanged(w)
                self.assertIsNotNone(w.batch())

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        r = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
        return bool(r.stdout.strip()) and not r.stdout.strip().startswith('Z')


class DecideTest(unittest.TestCase):
    def test_fresh_branch_all_noinit_writes_no_cursor(self):
        w = Workspace(self, comments=[comment(i, at(i)) for i in range(1, 6)])
        w.session_loop(segments=3, modes=['noinit'] * 3)
        self.assertEqual(w.exits(), ['1:noinit', '2:noinit', '3:noinit'])
        self.assertNotIn('FEEDBACK_CURSOR', git(w.ws, 'status', '--porcelain', '--untracked-files=all'))
        self.assertFalse(w.branch_cursor_path().exists())
        start = (w.rt / 'start-sha').read_text()
        self.assertEqual(git(w.ws, 'rev-list', f'{start}..HEAD'), '')
        self.assertEqual((w.rt / 'feedback-pending').read_text().strip(), '5')
        (w.ws / DOCS / 'PHASE').write_text('build')
        r, out, genv = run_decide(w)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(out['continue'], 'false')
        self.assertEqual(out['idle'], 'false')
        self.assertIn('every segment failed', genv)

    def test_a_segment_that_was_not_contained_ends_the_loop(self):
        w = Workspace(self)
        (w.ws / DOCS / 'PHASE').write_text('build')
        (w.rt / 'segment-exits').write_text('1:0\n')
        r, out, genv = run_decide(w, SEGMENT_FAILED='true')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(out['continue'], 'false')
        self.assertIn('could not stop everything the builder started', genv)

    def test_uncommitted_pending_feedback_does_not_block_idle(self):
        for committed in (False, True):
            with self.subTest(committed=committed):
                w = Workspace(self)
                (w.ws / DOCS / 'PHASE').write_text('build')
                git(w.ws, 'add', '-A')
                git(w.ws, 'commit', '-q', '-m', 'phase')
                (w.rt / 'start-sha').write_text(git(w.ws, 'rev-parse', 'HEAD').strip())
                (w.ws / DOCS / 'NOTES.md').write_text('waiting')
                git(w.ws, 'add', '-A')
                git(w.ws, 'commit', '-q', '-m', 'notes')
                (w.rt / 'segment-exits').write_text('1:0\n2:0\n3:0\n')
                (w.rt / 'segment-1.phase').write_text('build')
                (w.rt / 'feedback-pending').write_text('1')
                if committed:
                    (w.rt / 'feedback-committed').touch()
                r, out, _ = run_decide(w)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(out['idle'], 'false' if committed else 'true')
                self.assertEqual(out['continue'], 'true' if committed else 'false')

    def test_cursor_only_commit_does_not_keep_a_failing_loop_alive(self):
        w = Workspace(self)
        (w.ws / DOCS / 'FEEDBACK_CURSOR.json').write_text('{}')
        git(w.ws, 'add', '-A')
        git(w.ws, 'commit', '-q', '-m', 'cursor')
        (w.rt / 'segment-exits').write_text('1:1\n2:1\n3:1\n')
        _, out, genv = run_decide(w)
        self.assertEqual(out['continue'], 'false')
        self.assertIn('every segment failed', genv)


class ReplayTest(unittest.TestCase):
    def delivered_session(self, items, **kw):
        w = Workspace(self, comments=items, **kw)
        w.run_feedback()
        w.run_segment(1)
        self.assertEqual(w.read_cursor()['rev'], 1)
        return w

    def stable(self, cur):
        return {k: cur[k] for k in ('floor', 'delivered', 'watermark', 'safe_at')}

    def test_replay_redelivers_from_comment_without_rewinding_on_failure(self):
        items = [comment(i, at(i)) for i in range(1, 5)]
        w = self.delivered_session(items)
        before = w.branch_cursor()
        w.new_session()
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='2')
        persisted = w.branch_cursor()
        self.assertEqual(persisted['replay']['from_key'], 'comment:2')
        self.assertEqual(persisted['replay']['delivered'], [])
        self.assertEqual(persisted['rev'], before['rev'] + 1)
        self.assertEqual(self.stable(persisted), self.stable(before), 'nothing rewound')
        b = w.batch()
        self.assertEqual(b['keys'], keys(items[1:]))
        self.assertEqual(b['replay'], 'comment:2')
        self.assertIn('_Replay from comment:2 requested by a maintainer: some of these were delivered before._',
                      (w.rt / 'feedback.md').read_text())
        self.assertIn('replay from comment:2', r.stdout)
        w.run_segment(1, STUB_CLAUDE_MODE='exit1')
        self.assertEqual(w.branch_cursor(), persisted, 'a failed batch changes nothing')

    def test_replay_request_survives_failed_session(self):
        items = [comment(i, at(i)) for i in range(1, 4)]
        w = self.delivered_session(items)
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='comment:2')
        w.run_segment(1, STUB_CLAUDE_MODE='exit1')
        w.new_session()
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], keys(items[1:]))
        w.run_segment(1)
        cur = w.branch_cursor()
        self.assertIsNone(cur['replay'])
        self.assertIn('comment:2', cur['replay_done'])

    def test_replay_request_survives_failed_first_fetch(self):
        items = [comment(i, at(i)) for i in range(1, 4)]
        w = self.delivered_session(items)
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='3', GH_FAIL='issues/27/comments')
        self.assertIsNone(w.batch())
        w.run_feedback()  # a refresh step: no replay env
        self.assertEqual(w.batch()['keys'], ['comment:3'])
        self.assertEqual(w.branch_cursor()['replay']['from_key'], 'comment:3')

    def test_replay_progress_persists_and_completes(self):
        items = [comment(i, at(i), body=f'MARK-{i}-END ' + 'x' * 1500) for i in range(1, 5)]
        w = Workspace(self, comments=items)
        w.extra_env = {'LEXI_FEEDBACK_BATCH_BYTES': '4096'}
        drain(w)
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='1')
        self.assertEqual(w.batch()['keys'], keys(items[0:2]))
        w.run_segment(1)
        cur = w.branch_cursor()
        self.assertEqual(cur['replay']['delivered'], keys(items[0:2]))
        w.run_feedback()
        self.assertEqual(w.batch()['keys'], keys(items[2:4]))
        w.run_segment(2)
        cur = w.branch_cursor()
        self.assertIsNone(cur['replay'])
        self.assertEqual(cur['replay_done'], ['comment:1'])
        w.run_feedback()
        self.assertIsNone(w.batch(), 'a finished replay does not restart in the same session')

    def test_replay_done_is_not_repeated(self):
        items = [comment(i, at(i)) for i in range(1, 3)]
        w = self.delivered_session(items)
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='1')
        w.run_segment(1)
        self.assertIsNone(w.branch_cursor()['replay'])
        w.new_session()
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='1')
        self.assertIn('::notice::Replay from comment:1 already completed; unset LEXI_FEEDBACK_REPLAY_FROM.', r.stdout)
        self.assertIsNone(w.batch())
        # An explicit input asks for it again.
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='1')
        self.assertEqual(w.batch()['keys'], keys(items))

    def test_replay_not_on_pr_is_ignored(self):
        w = Workspace(self, comments=[comment(1, at(0))])
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='999999')
        self.assertIn('::warning::Replay from comment:999999 was requested (variable), but no such comment is on this PR; ignored.', r.stdout)
        self.assertEqual(w.batch()['keys'], ['comment:1'])
        self.assertIsNone(w.batch()['replay'])
        self.assertFalse(w.branch_cursor_path().exists())

    def test_invalid_replay_stops_session(self):
        for value in ('abc', 'comment:', '1' * 30, 'IC_x', '$(id)'):
            with self.subTest(value=value):
                w = Workspace(self, comments=[comment(1, at(0))])
                r = w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT=value)
                self.assertIn('::error::The replay request', r.stdout + r.stderr)
                self.assertIn('is not a comment id', (w.rt / 'stop-reason').read_text())
                self.assertIsNone(w.batch())
                self.assertFalse(w.branch_cursor_path().exists())
                if value == '$(id)':
                    self.assertNotIn(value, r.stdout + r.stderr, 'the raw value is not echoed')
                w.run_segment(1)
                self.assertEqual(w.exits(), ['1:skip'])

    def test_variable_does_not_replace_input_replay(self):
        items = [comment(i, at(i)) for i in range(1, 4)]
        w = self.delivered_session(items)
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='1')
        w.new_session()
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='3')
        self.assertIn('::warning::Replay from comment:1 is in progress; LEXI_FEEDBACK_REPLAY_FROM=comment:3 waits until it completes.', r.stdout)
        self.assertEqual(w.batch()['replay'], 'comment:1')
        self.assertEqual(w.branch_cursor()['replay']['from_key'], 'comment:1')

    def test_input_replaces_in_progress_replay(self):
        items = [comment(i, at(i)) for i in range(1, 4)]
        w = self.delivered_session(items)
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='1')
        rev = w.branch_cursor()['rev']
        w.new_session()
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='3')
        self.assertIn('::notice::Replay from comment:3 replaces the replay from comment:1 in progress.', r.stdout)
        self.assertEqual(w.branch_cursor()['replay']['from_key'], 'comment:3')
        self.assertEqual(w.branch_cursor()['rev'], rev + 1)
        self.assertEqual(w.batch()['keys'], ['comment:3'])

    def test_replay_with_nothing_to_deliver_completes_at_init(self):
        report = comment(50, at(30), who=LEXI, body='<!-- app-build:report -->\n<!-- app-build:feedback-cursor=v1 -->')
        w = self.delivered_session([comment(1, at(0)), report], authors=f'alice,{LEXI}')
        before = w.branch_cursor()
        w.new_session()
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='comment:50')
        self.assertIn('::notice::Replay from comment:50 has nothing to deliver; marked complete.', r.stdout)
        cur = w.branch_cursor()
        self.assertIsNone(cur['replay'])
        self.assertIn('comment:50', cur['replay_done'])
        self.assertEqual(cur['rev'], before['rev'] + 1)
        self.assertEqual(self.stable(cur), self.stable(before))
        self.assertEqual(w.read_cursor(), cur)
        self.assertIsNone(w.batch())
        w.new_session()
        r = w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR='comment:50')
        self.assertIn('already completed', r.stdout)

    def test_replay_skips_reports_and_assessments(self):
        items = [comment(1, at(0)),
                 comment(2, at(1), who=LEXI, body='<!-- app-build:report -->\nreport MARK-2-END'),
                 comment(3, at(2), who=LEXI, body='<!-- app-build:assessment app=web -->\nMARK-3-END'),
                 comment(4, at(3))]
        w = self.delivered_session(items, authors=f'alice,{LEXI}')
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='1')
        self.assertEqual(w.batch()['keys'], ['comment:1', 'comment:4'])
        w.new_session()
        w.run_feedback(LEXI_FEEDBACK_REPLAY_INPUT='2')
        self.assertEqual(w.branch_cursor()['replay']['from_key'], 'comment:2')
        self.assertEqual(w.batch()['keys'], ['comment:4'])

    def test_replay_of_iqa_comment_6173802225_in_every_form(self):
        cid = 6173802225
        iqa = comment(cid, '2026-10-14T17:02:31Z', who=IQA, body='iqa QA result: Home, CFDs MARK-6173802225-END')
        iqa['node_id'] = 'IC_kwDOU94vQs8AAAABb_y-8Q'
        older = comment(6100000000, '2026-10-12T10:00:00Z', who=IQA)
        later = [comment(6200000000 + i, f'2026-10-16T0{i}:00:00Z', who=IQA) for i in range(1, 4)]
        w = self.delivered_session([older, iqa] + later, authors=f'*,{LEXI},{IQA}')
        saved = w.branch_cursor_path().read_text()
        for form in ('6173802225', 'comment:6173802225', 'IC_kwDOU94vQs8AAAABb_y-8Q'):
            with self.subTest(form=form):
                w.branch_cursor_path().write_text(saved)
                w.new_session()
                r = w.run_feedback(LEXI_FEEDBACK_REPLAY_VAR=form)
                self.assertIn('replay from comment:6173802225', r.stdout)
                b = w.batch()
                self.assertEqual(b['replay'], 'comment:6173802225')
                self.assertEqual(b['keys'], keys([iqa] + later))
                w.run_segment(1)
                cur = w.branch_cursor()
                self.assertIsNone(cur['replay'])
                self.assertIn('comment:6173802225', cur['replay_done'])
                self.assertEqual(self.stable(cur), self.stable(json.loads(saved)), 'nothing rewound')


class ReportFeedbackTest(unittest.TestCase):
    def test_failed_sessions_on_fresh_pr_do_not_skip_feedback(self):
        for start_fetch_fails in (False, True):
            with self.subTest(start_fetch_fails=start_fetch_fails):
                w = Workspace(self, comments=[comment(1, at(0))])
                for s in (1, 2):
                    if s > 1:
                        w.new_session()
                    fail = 'issues/27/comments' if (start_fetch_fails and s == 1) else None
                    w.run_feedback(GH_FAIL=fail)
                    w.run_segment(1, STUB_CLAUDE_MODE='noinit')
                    w.run_report(PUSH_OUTCOME='success')
                    posted = (w.rt / 'posted.md').read_text()
                    self.assertIn('<!-- app-build:feedback-cursor=v1 -->', posted)
                    if fail:
                        self.assertNotIn('feedback-read-at', posted)
                    else:
                        self.assertIn('<!-- app-build:feedback-read-at=1970-01-01T00:00:00Z -->', posted)
                self.assertEqual(len(w.data()['comments']), 3, 'two reports posted after the comment')
                w.new_session()
                w.run_feedback()
                w.run_segment(1)
                self.assertEqual(w.delivered_keys(1), ['comment:1'])
                self.assertEqual(w.read_cursor()['rev'], 1)

    def test_report_after_success_publishes_processed_through(self):
        w = Workspace(self, comments=[comment(1, at(0)), comment(2, at(1))])
        w.run_feedback()
        w.run_segment(1)
        w.run_report(PUSH_OUTCOME='success')
        posted = (w.rt / 'posted.md').read_text()
        self.assertIn(f'<!-- app-build:feedback-read-at={at(1)} -->', posted)
        self.assertIn('**Feedback:** 2 comment(s) delivered in 1 batch(es) this session; 0 pending.', posted)
        self.assertNotIn('MARK-', posted)


if __name__ == '__main__':
    unittest.main()
