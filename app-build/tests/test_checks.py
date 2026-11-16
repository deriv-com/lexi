"""Run shell checks with local tool doubles; no network or app installs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]


class ChecksTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.app = self.root / "repo/app/web"
        self.app.mkdir(parents=True)
        self.runner = self.root / "runner"
        (self.runner / "app-build").mkdir(parents=True)
        (self.runner / "app-build/visual-report.mjs").write_text("// Scoring is tested separately.\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("npm", "npx"):
            self.write_tool(name, '#!/bin/bash\nprintf "%s\\n" "' + name + ' $*" >> "$CALL_LOG"\n[ "$*" != "${FAIL_COMMAND:-}" ]\n')
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", RUNNER_TEMP=str(self.runner),
                        GITHUB_WORKSPACE=str(self.root / "repo"), LEXI_APP="web", LEXI_APP_DIR="app/web",
                        LEXI_SESSION="1", CALL_LOG=str(self.root / "calls"), LEXI_TESTS="e2e")
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "user.email", "test@example.com")
        (self.root / "repo/seed").write_text("seed")
        self.git("add", ".")
        self.git("commit", "-qm", "seed")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root / "repo", text=True).strip()

    def write_tool(self, name, body):
        target = self.bin / name
        target.write_text(body)
        target.chmod(0o755)

    def run_checks(self, extra_scripts=None):
        scripts = {name: "test command" for name in ("lint", "test", "build")}
        scripts.update(extra_scripts or {})
        (self.app / "package.json").write_text(json.dumps({"scripts": scripts, "devDependencies": {"@playwright/test": "1.0.0"}}))
        result = subprocess.run(["bash", str(TOOLS / "checks.sh")], cwd=self.app, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((self.runner / "checks/checks.json").read_text()), (self.root / "calls").read_text()

    def test_missing_browser_and_visual_scripts_are_reported(self):
        checks, _ = self.run_checks()
        self.assertIn({"name": "browser tests", "status": "missing"}, [{"name": c["name"], "status": c["status"]} for c in checks])
        self.assertTrue(any(c["name"] == "visual regression" and c["status"] == "missing" for c in checks))

    def test_e2e_runs_once_and_failed_exit_is_preserved(self):
        self.env["FAIL_COMMAND"] = "run test:e2e"
        checks, calls = self.run_checks({"test:e2e": "playwright test", "lexi:journeys": "legacy", "test:visual": "visual"})
        self.assertEqual(calls.count("npm run test:e2e\n"), 1)
        self.assertNotIn("npm run lexi:journeys", calls)
        self.assertIn("npx --no-install playwright install --with-deps", calls)
        self.assertFalse(any("next start" in line or "next dev" in line for line in calls.splitlines()))
        self.assertTrue(any(c["name"] == "browser journeys (app-configured target)" and c["status"] == "fail" for c in checks))

    def test_assess_browser_false_runs_no_browser_suite(self):
        self.env["LEXI_ASSESS_BROWSER"] = "false"
        checks, calls = self.run_checks({"test:e2e": "playwright test", "lexi:journeys": "legacy", "test:visual": "visual"})
        self.assertNotIn("playwright install", calls)
        self.assertNotIn("npm run test:e2e", calls)
        self.assertNotIn("npm run lexi:journeys", calls)
        self.assertNotIn("npm run test:visual", calls)
        self.assertIn("npm run test", calls)
        self.assertIn({"name": "browser tests (turned off by assess_browser)", "status": "missing"}, [{"name": c["name"], "status": c["status"]} for c in checks])

    def test_assessment_runs_configured_browser_suites_after_a_unit_only_builder(self):
        self.env["LEXI_TESTS"] = "unit"
        _, calls = self.run_checks({"test:e2e": "playwright test", "test:smoke": "smoke", "test:visual": "visual"})
        self.assertNotIn("npm run test:smoke", calls)
        self.assertIn("npm run test:e2e", calls)
        self.assertIn("npm run test:visual", calls)
        self.assertIn("playwright install", calls)

    def test_combined_browser_suite_does_not_require_a_separate_visual_command(self):
        self.env["LEXI_TESTS"] = "unit"
        checks, calls = self.run_checks({"test:e2e": "playwright test"})
        self.assertIn("npm run test:e2e", calls)
        self.assertFalse(any(c["status"] == "missing" for c in checks))

    def test_unit_policy_does_not_require_browser_scripts(self):
        self.env["LEXI_TESTS"] = "unit"
        checks, _ = self.run_checks()
        self.assertTrue(all(c["status"] == "pass" for c in checks))

    def test_legacy_journey_command_still_runs_without_claiming_staging(self):
        self.write_tool("curl", "#!/bin/bash\nexit 0\n")
        checks, calls = self.run_checks({"lexi:journeys": "legacy", "test:visual": "visual"})
        self.assertEqual(calls.count("npm run lexi:journeys\n"), 1)
        self.assertTrue(any(c["name"] == "browser journeys (legacy target)" and c["status"] == "pass" for c in checks))
        self.assertFalse(any("staging" in c["name"] for c in checks))

    def test_each_result_is_saved_before_the_next_command_starts(self):
        self.write_tool("npm", '\n'.join([
            '#!/bin/bash',
            'printf "%s\\n" "npm $*" >> "$CALL_LOG"',
            'if [ "$*" = "run test:e2e" ]; then',
            '  cp "$RUNNER_TEMP/checks/checks.json" "$RUNNER_TEMP/before-browser.json"',
            '  cp "$RUNNER_TEMP/checks/CHECKS.md" "$RUNNER_TEMP/before-browser.md"',
            'fi',
        ]) + '\n')
        self.run_checks({"test:e2e": "playwright test"})
        saved = json.loads((self.runner / "before-browser.json").read_text())
        self.assertTrue(any(c['name'] == 'build' and c['status'] == 'pass' for c in saved))
        self.assertIn('| build | pass |', (self.runner / "before-browser.md").read_text())

    def test_raw_json_and_url_encoded_credentials_never_reach_saved_logs(self):
        secret = 'fake+pa"ss/word'
        self.env['STAGING_REAL_PASSWORD'] = secret
        self.write_tool('npm', '#!/bin/bash\nprintf "%s\\n" "npm $*" >> "$CALL_LOG"\n' +
                        'node -e \'const v=process.env.STAGING_REAL_PASSWORD;console.log(v,JSON.stringify(v),encodeURIComponent(v))\'\n')
        self.run_checks()
        from urllib.parse import quote
        for path in (self.runner / 'checks').rglob('*'):
            if path.is_file():
                value = path.read_text()
                for form in (secret, json.dumps(secret)[1:-1], quote(secret, safe='')):
                    self.assertNotIn(form, value, str(path))
        self.assertEqual((self.runner / 'checks/logs').stat().st_mode & 0o777, 0o700)

    def test_no_prototype_url_is_invented_from_the_default_directory(self):
        self.env['LEXI_PROTOTYPE_DIR'] = 'prototype'
        self.env.pop('LEXI_PROTOTYPE_URL', None)
        self.write_tool('npm', '#!/bin/bash\nprintf "%s\\n" "npm $*" >> "$CALL_LOG"\n' +
                        'printf "%s" "${LEXI_PROTOTYPE_URL:-}" > "$RUNNER_TEMP/prototype-url"\n')
        self.run_checks()
        self.assertEqual((self.runner / 'prototype-url').read_text(), '')

    def test_mobile_visual_path_is_data_even_with_a_shell_quote(self):
        app = self.root / "repo/app/mobile's"
        (app / 'tools/visual').mkdir(parents=True)
        (app / 'pubspec.yaml').write_text('name: example_app')
        (app / 'tools/visual/package.json').write_text(json.dumps({'scripts': {'lexi:visual': 'example'}}))
        self.env.update(LEXI_APP='mobile', LEXI_APP_DIR="app/mobile's")
        self.write_tool('flutter', '#!/bin/bash\nexit 0\n')
        result = subprocess.run(['bash', str(TOOLS / 'checks.sh')], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.root / 'calls').read_text()
        self.assertIn('npm run lexi:visual', calls)
        checks = json.loads((self.runner / 'checks/checks.json').read_text())
        self.assertTrue(any(c['name'] == 'visual + accessibility' and c['status'] == 'pass' for c in checks))

    def test_mobile_keeps_its_existing_flutter_commands(self):
        app = self.root / "repo/app/mobile"
        (app / "test").mkdir(parents=True)
        (app / "pubspec.yaml").write_text("name: test_app\n")
        self.env.update(LEXI_APP="mobile", LEXI_APP_DIR="app/mobile")
        self.write_tool("flutter", '#!/bin/bash\nprintf "%s\\n" "flutter $*" >> "$CALL_LOG"\n')
        result = subprocess.run(["bash", str(TOOLS / "checks.sh")], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "calls").read_text().splitlines(), ["flutter pub get", "flutter analyze", "flutter test", "flutter build web --release", "flutter build apk --debug"])



class SyncBaseTest(unittest.TestCase):
    def run_case(self, conflict=False, fetch_failure=False, transient=False, unrelated=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            git = lambda *args: subprocess.check_output(["git", *args], cwd=repo, text=True).strip()
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Test")
            git("config", "commit.gpgsign", "false")
            git("config", "user.email", "test@example.com")
            (repo / "BUILD.md").write_text("base\n")
            git("add", ".")
            git("commit", "-qm", "base")
            git("checkout", "-qb", "builder")
            (repo / ("BUILD.md" if conflict else "feature.txt")).write_text("builder\n")
            git("add", ".")
            git("commit", "-qam", "builder")
            before = git("rev-parse", "HEAD")
            git("checkout", "-q", "main")
            (repo / "BUILD.md").write_text("updated policy\n")
            git("commit", "-qam", "policy")
            if unrelated:
                git("checkout", "-q", "--orphan", "unrelated")
                git("rm", "-qrf", ".")
                (repo / "other.txt").write_text("unrelated history\n")
                git("add", ".")
                git("commit", "-qm", "unrelated")
            git("checkout", "-q", "builder")
            bindir = root / "bin"
            bindir.mkdir()
            wrapper = bindir / "git"
            wrapper.write_text(f'''#!/bin/bash
printf '%s\\n' "$*" >> "$RUNNER_TEMP/git-args"
while [ "$1" = -c ]; do shift 2; done
if [ "$1" = fetch ]; then
  count=$(cat "$RUNNER_TEMP/fetch-count" 2>/dev/null || echo 0)
  count=$((count + 1)); echo "$count" > "$RUNNER_TEMP/fetch-count"
  [ "$count" -le "${{FAIL_FETCH_COUNT:-0}}" ] && exit 3
  shift 3
  exec "{shutil.which("git")}" fetch -q . "$@"
fi
exec "{shutil.which("git")}" "$@"
''')
            (bindir / 'sleep').write_text('#!/bin/bash\nexit 0\n')
            (bindir / 'sleep').chmod(0o755)
            wrapper.chmod(0o755)
            env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", GH_TOKEN="secret-token", GITHUB_REPOSITORY="test/test",
                       LEXI_BASE="unrelated" if unrelated else "main", LEXI_BRANCH="builder", RUNNER_TEMP=tmp,
                       FAIL_FETCH_COUNT="4" if fetch_failure else "1" if transient else "0")
            result = subprocess.run(["bash", str(TOOLS / "sync-base.sh")], cwd=repo, env=env, capture_output=True, text=True)
            if conflict:
                # The builder merges a conflicted base as its first task; the session goes on.
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(git("rev-parse", "HEAD"), before)
                self.assertFalse((root / "stop-reason").exists())
                note = (root / "merge-note.md").read_text()
                self.assertIn("git merge origin/main", note)
                self.assertIn("- `BUILD.md`", note)
            elif fetch_failure or unrelated:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(git("rev-parse", "HEAD"), before)
                self.assertTrue((root / "stop-reason").exists())
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((repo / "BUILD.md").read_text(), "updated policy\n")
                self.assertFalse((root / "stop-reason").exists())
            self.assertEqual(git("status", "--porcelain"), "")
            self.assertNotIn('secret-token', (root / 'git-args').read_text())
            self.assertEqual(int((root / 'fetch-count').read_text()), 4 if fetch_failure else 2 if transient else 1)
            if unrelated:
                self.assertIn('Could not merge the base', result.stdout)
                self.assertNotIn('There is no merge to abort', result.stderr)

    def test_conflict_leaves_the_merge_to_the_builder_without_stopping(self):
        self.run_case(conflict=True)

    def test_fetch_failure_stops_session_before_building(self):
        self.run_case(fetch_failure=True)

    def test_transient_fetch_failure_retries_without_stopping(self):
        self.run_case(transient=True)

    def test_unrelated_history_reports_merge_failure_without_abort_error(self):
        self.run_case(unrelated=True)

    def test_clean_merge_updates_the_current_build_instructions(self):
        self.run_case()


if __name__ == "__main__":
    unittest.main()
