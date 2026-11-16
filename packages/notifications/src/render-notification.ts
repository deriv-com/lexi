import {
  renderCannotReproduceTemplate,
  renderEscalationTemplate,
  renderManualInvestigationTemplate,
  renderNeedsInfoTemplate,
  renderReminderTemplate,
  renderVerifiedTemplate,
} from "./templates";
import { NotificationContext, NotificationTemplateName, RenderedNotification } from "./types";

const RENDERERS: Record<NotificationTemplateName, (ctx: NotificationContext) => RenderedNotification> = {
  VERIFIED: renderVerifiedTemplate,
  NEEDS_INFO: renderNeedsInfoTemplate,
  CANNOT_REPRODUCE: renderCannotReproduceTemplate,
  MANUAL_INVESTIGATION: renderManualInvestigationTemplate,
  REMINDER: renderReminderTemplate,
  ESCALATION: renderEscalationTemplate,
};

export function renderNotification(template: NotificationTemplateName, ctx: NotificationContext): RenderedNotification {
  return RENDERERS[template](ctx);
}
