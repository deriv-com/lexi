/** A piece the deployment has not configured (no model key, no GitHub credentials). */
export class NotWiredError extends Error {
  constructor(readonly component: string) {
    super(`${component} is not wired in this deployment (see apps/server/src/wiring/runtime-wiring.ts).`);
    this.name = "NotWiredError";
  }
}

/** A repository the deployment does not manage. */
export class UnknownRepositoryError extends Error {
  constructor(readonly repository: string) {
    super(`Repository ${repository} is not one this deployment manages.`);
    this.name = "UnknownRepositoryError";
  }
}
