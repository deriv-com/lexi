export const ACTION_ID_PREFIX = "lexi_";

export function hubReachBlocks(issueNumber: number): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: formatHubReachQuestion() },
    },
    {
      type: "actions",
      block_id: `hub_reach_${issueNumber}`,
      elements: [
        actionButton("Home screen loaded", `${ACTION_ID_PREFIX}hub_yes_${issueNumber}`, "authenticated_hub"),
        actionButton("Blocked before login", `${ACTION_ID_PREFIX}hub_no_${issueNumber}`, "blocked_pre_login"),
        actionButton("Not sure", `${ACTION_ID_PREFIX}hub_unsure_${issueNumber}`, "hub_unsure"),
        actionButton("Add evidence", `${ACTION_ID_PREFIX}add_evidence_${issueNumber}`, "add_evidence"),
      ],
    },
  ];
}

export function blockedFlowBlocks(issueNumber: number): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "What blocked the flow?" },
    },
    {
      type: "actions",
      block_id: `blocked_flow_${issueNumber}`,
      elements: [
        actionButton("OTP", `${ACTION_ID_PREFIX}blocked_otp_${issueNumber}`, "otp"),
        actionButton("KYC", `${ACTION_ID_PREFIX}blocked_kyc_${issueNumber}`, "kyc"),
        actionButton("Payment", `${ACTION_ID_PREFIX}blocked_payment_${issueNumber}`, "payment"),
        actionButton("Credentials", `${ACTION_ID_PREFIX}blocked_credentials_${issueNumber}`, "credentials"),
        actionButton("Environment", `${ACTION_ID_PREFIX}blocked_environment_${issueNumber}`, "environment"),
      ],
    },
  ];
}

export function pendingClosureBlocks(issueNumber: number, scheduledDate: string): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `This issue is eligible for pending closure on ${scheduledDate}.`,
      },
    },
    {
      type: "actions",
      block_id: `pending_closure_${issueNumber}`,
      elements: [
        actionButton("Keep open", `${ACTION_ID_PREFIX}keep_open_${issueNumber}`, "keep_open"),
        actionButton("Add evidence", `${ACTION_ID_PREFIX}add_evidence_${issueNumber}`, "add_evidence"),
        actionButton("Reprocess", `${ACTION_ID_PREFIX}reprocess_${issueNumber}`, "reprocess"),
        actionButton("View report", `${ACTION_ID_PREFIX}view_report_${issueNumber}`, "view_report"),
      ],
    },
  ];
}

function actionButton(label: string, actionId: string, value: string): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: actionId,
    value,
  };
}

function formatHubReachQuestion(): string {
  return "You reported that the issue was not reproduced. Did you reach the signed-in home screen?";
}
