"""Check rendered builder policies for independent CI and QA."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ, LEXI_TESTS="unit",
                        LEXI_BROWSER_CHECK="true", PROMPT_PROTOTYPE_NOTE="Local prototype.")

    def policy(self):
        result = subprocess.run(
            ["bash", "-uc", 'source "$1"; node -e \'console.log(JSON.stringify(process.env))\'',
             "_", str(TOOLS / "build-policy.sh")], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def render(self, name):
        template = TOOLS / name
        env = dict(self.env)
        for placeholder in re.findall(r"__([A-Z_]+)__", template.read_text()):
            env.setdefault(f"PROMPT_{placeholder}", "example")
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "prompt.md"
            result = subprocess.run(
                ["bash", "-uc", 'source "$1"; node "$2" "$3" "$4"', "_",
                 str(TOOLS / "build-policy.sh"), str(TOOLS / "render-prompt.mjs"),
                 str(template), str(output)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return output.read_text()

    def test_build_md_decides_who_writes_the_browser_suites(self):
        self.env["LEXI_BROWSER_CHECK"] = "false"
        for name in ("prompt-first.md", "prompt-continue.md", "prompt-phase-plan.md",
                     "prompt-phase-spec.md"):
            with self.subTest(template=name):
                prompt = self.render(name)
                self.assertIn("BUILD.md decides who writes, maintains and repairs browser", prompt)
                self.assertIn("Where it says not to, write none and leave existing ones alone", prompt)
                self.assertIn("Do not run browser suites in the builder", prompt)
                self.assertNotIn("repair them", prompt)
                self.assertNotIn("do not write, plan or run them", prompt)
                self.assertNotIn("__TEST_POLICY__", prompt)
                self.assertNotIn("use the browser tools", prompt)
        policy = self.policy()
        self.assertIn("No browser in this run", policy["PROMPT_BROWSER_NOTE"])
        self.assertEqual(policy["PROMPT_FLEET_LOOK"], "")
        gate = policy["PROMPT_GATE_TEST_POLICY"]
        self.assertIn("only where BUILD.md does", gate)
        self.assertIn("do not fail a phase for leaving them out where it says not to", gate)
        self.assertIn("Do not require browser execution", gate)

    def test_fleet_writes_only_the_suites_build_md_assigns(self):
        self.env['LEXI_TESTS'] = 'e2e'
        prompt = self.render('fleet.md')
        self.assertIn('Write only the test suites BUILD.md assigns to your item', prompt)
        self.assertIn('where it says not to write browser or visual suites, write none', prompt)
        self.assertIn('Run only your own unit and component tests', prompt)
        self.assertNotIn('__FLEET_TEST_POLICY__', prompt)

    def test_no_browser_builder_does_not_run_browser_suites(self):
        self.env.update(LEXI_TESTS='e2e', LEXI_BROWSER_CHECK='false')
        policy = self.policy()
        self.assertIn('Do not run browser suites in the builder', policy['PROMPT_TEST_POLICY'])
        self.assertIn('Any browser evidence is collected outside the builder session', policy['PROMPT_BROWSER_NOTE'])
        self.assertIn('Status: done means the builder scope is complete', policy['PROMPT_TEST_POLICY'])
        self.assertNotIn('Completion needs', policy['PROMPT_TEST_POLICY'])
        self.assertNotIn('completion still needs', policy['PROMPT_GATE_TEST_POLICY'])

    def test_unit_policy_can_keep_manual_browser_inspection(self):
        policy = self.policy()
        self.assertIn("Do not run browser suites", policy["PROMPT_TEST_POLICY"])
        self.assertNotIn("do not run browsers or", policy["PROMPT_TEST_POLICY"])
        self.assertIn("use the browser tools", policy["PROMPT_BROWSER_NOTE"])

    def test_gate_stops_when_its_rubric_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = root / 'runner/app-build'
            tools.mkdir(parents=True)
            shutil.copyfile(TOOLS / 'build-policy.sh', tools / 'build-policy.sh')
            docs = root / 'repo/app/web/docs/build'
            docs.mkdir(parents=True)
            (docs / 'PHASE').write_text('spec')
            env = dict(self.env, RUNNER_TEMP=str(root / 'runner'), GITHUB_WORKSPACE=str(root / 'repo'),
                       LEXI_APP_DIR='app/web', LEXI_APP_LABEL='Example app')
            result = subprocess.run(['bash', str(TOOLS / 'gate.sh'), 'spec'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('Could not load the spec gate rubric', result.stderr)
            self.assertEqual((docs / 'PHASE').read_text(), 'spec')

    def test_e2e_policy_keeps_browser_checks(self):
        self.env["LEXI_TESTS"] = "e2e"
        policy = self.policy()
        self.assertIn("end-to-end journey tests", policy["PROMPT_TEST_POLICY"])
        self.assertIn("Where BUILD.md says not to write browser or visual suites, write none", policy["PROMPT_TEST_POLICY"])
        self.assertIn("use the browser tools", policy["PROMPT_BROWSER_NOTE"])


if __name__ == "__main__":
    unittest.main()
