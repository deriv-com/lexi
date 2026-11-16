#!/usr/bin/env bash
# Sourced by builder and gate prompts so their test policies agree.
export PROMPT_TEST_POLICY PROMPT_GATE_TEST_POLICY PROMPT_FLEET_TEST_POLICY
PROMPT_GATE_TEST_POLICY=""
PROMPT_FLEET_TEST_POLICY="Write only the test suites BUILD.md assigns to your item; where it says not to write browser or visual suites, write none. Run only your own unit and component tests. Leave full-suite execution to the lead."
if [ "${LEXI_TESTS:-e2e}" = unit ] || [ "${LEXI_BROWSER_CHECK:-true}" = false ]; then
  PROMPT_TEST_POLICY="Test execution here is limited to unit and component tests, with the network mocked at the client boundary. Do not run browser suites in the builder. BUILD.md decides who writes, maintains and repairs browser, visual, accessibility and performance suites: do that work only where it assigns it to you. Where it says not to, write none and leave existing ones alone."
  PROMPT_GATE_TEST_POLICY="The builder runs unit and component tests only. BUILD.md decides who writes browser, visual, accessibility and performance suites. Require the plan to assign them only where BUILD.md does, and do not fail a phase for leaving them out where it says not to. Do not require browser execution in the builder."
else
  PROMPT_TEST_POLICY="Test policy for this run: unit tests plus the end-to-end journey tests the plan names. Where BUILD.md says not to write browser or visual suites, write none."
fi
COMPLETION_POLICY='Status: done means the builder scope is complete. List missing independent evidence as incomplete in LAST_SESSION.md; this status is not a QA verdict.'
PROMPT_TEST_POLICY="$PROMPT_TEST_POLICY $COMPLETION_POLICY"
PROMPT_GATE_TEST_POLICY="$PROMPT_GATE_TEST_POLICY $COMPLETION_POLICY"

export PROMPT_BROWSER_NOTE PROMPT_FLEET_LOOK
if [ "${LEXI_BROWSER_CHECK:-true}" = false ]; then
  PROMPT_BROWSER_NOTE="No browser in this run: do not start the app to look at it, do not take screenshots, and do not try to install a browser. Build each screen from the spec, the design system, the intake issues' screenshots (open the image files) and the reference code, and prove it with unit and component tests. Any browser evidence is collected outside the builder session."
  PROMPT_FLEET_LOOK=""
else
  PROMPT_BROWSER_NOTE="See what you build. ${PROMPT_PROTOTYPE_NOTE:-} Run your app locally and use the browser tools (the \`playwright\` MCP server) to click through each journey like a person would: open, fill, submit, go back. Take screenshots and look at them, at desktop (1440×900) and mobile (390×844), and compare them with the prototype where it has the screen. Never report a screen done that you have not looked at."
  PROMPT_FLEET_LOOK="look at the new screens in the browser yourself, "
fi
