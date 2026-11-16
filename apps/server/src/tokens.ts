export { CONFIG_TOKEN } from "@lexi/config";
export { PRISMA_SERVICE_TOKEN } from "@lexi/database";
export { METRICS_REGISTRY_TOKEN } from "@lexi/metrics";

export const LOGGER_TOKEN = Symbol("LOGGER_TOKEN");
export const AUTHORIZATION_SERVICE_TOKEN = Symbol("AUTHORIZATION_SERVICE_TOKEN");
export const AGENT_TURN_RUNNER_TOKEN = Symbol("AGENT_TURN_RUNNER_TOKEN");
export const ISSUE_WORKFLOW_PORT_TOKEN = Symbol("ISSUE_WORKFLOW_PORT_TOKEN");
export const SLACK_APP_TOKEN = Symbol("SLACK_APP_TOKEN");
export const GITHUB_GATEWAY_TOKEN = Symbol("GITHUB_GATEWAY_TOKEN");
export const PROGRAMME_WIRING_TOKEN = Symbol("PROGRAMME_WIRING_TOKEN");
