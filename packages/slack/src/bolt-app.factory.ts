import { App } from "@slack/bolt";

export interface BoltAppFactoryOptions {
  token: string;
  signingSecret: string;
  appToken?: string;
  socketMode?: boolean;
}

export function createBoltApp(options: BoltAppFactoryOptions): App {
  return new App({
    token: options.token,
    signingSecret: options.signingSecret,
    appToken: options.appToken && options.appToken.length > 0 ? options.appToken : undefined,
    socketMode: Boolean(options.socketMode && options.appToken),
    // Bolt otherwise fires an unawaited `auth.test` call the instant the App
    // is constructed (before .start() is even called), which both makes
    // Node-process boot depend on a live Slack call and -- with placeholder
    // credentials in local/test environments -- surfaces as an unhandled
    // promise rejection. We verify tokens implicitly on first real call
    // instead (errors surface at that point via BoltSlackProvider's
    // try/catch), which keeps App construction itself side-effect-free.
    tokenVerificationEnabled: false,
  });
}
