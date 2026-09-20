import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { sendMessage, escapeMarkdownV2 } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import type { IssueLinksOpts } from "./formatters.js";
import { str } from "./coerce.js";

// ---------------------------------------------------------------------------
// Pending interaction cards (decision cards)
//
// The host emits no `interaction.*` plugin event, so pending cards are
// discovered indirectly:
//   (a) on `issue.updated` when an issue moves to `in_review` — the platform
//       convention is that a card is posted together with that transition;
//   (b) by a periodic sweep job over `in_review` issues, as a safety net for
//       cards created without the status transition or missed events.
// Both paths converge here. Durable per-interaction state (not just the
// in-memory sliding-window dedupe) prevents the sweep from re-notifying the
// same card on every run.
// ---------------------------------------------------------------------------

export type InteractionIssueRef = {
  id: string;
  identifier: string | null;
  title: string | null;
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}

const KIND_LABELS: Record<string, string> = {
  request_confirmation: "Confirmation",
  request_checkbox_confirmation: "Checkbox confirmation",
  request_item_verdicts: "Item verdicts",
  ask_user_questions: "Questions",
  suggest_tasks: "Suggested tasks",
  connection_intent: "Connection request",
};

export function interactionKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

/**
 * Deep link to the decision card in the web app. Falls back to the issue page
 * when the card anchor cannot be built; the anchor is harmless on hosts that
 * do not implement it (the browser just lands on the issue).
 */
export function interactionUrl(
  opts: IssueLinksOpts | undefined,
  identifier: string | null,
  interactionId: string,
): string | null {
  if (!opts?.baseUrl || !opts.issuePrefix || !identifier) return null;
  return `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}#interaction-${interactionId}`;
}

/**
 * List the pending interaction cards on an issue.
 *
 * Returns [] (and logs) when the host denies or lacks
 * `issue.interactions.read`, so callers degrade to the pre-existing behavior
 * instead of breaking on older hosts.
 */
export async function getPendingInteractions(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<IssueThreadInteraction[]> {
  try {
    const interactions = await ctx.issues.listInteractions(issueId, companyId);
    return interactions.filter((i) => i.status === "pending");
  } catch (err) {
    ctx.logger.warn("Could not list issue interactions", {
      issueId,
      companyId,
      error: String(err),
    });
    return [];
  }
}

export function formatPendingInteraction(
  interaction: IssueThreadInteraction,
  issue: InteractionIssueRef,
  requesterName: string | null,
  opts?: IssueLinksOpts,
): { text: string; options: SendMessageOptions } {
  const identifier = issue.identifier ?? issue.id;
  const kindLabel = interactionKindLabel(interaction.kind);
  const title = str(interaction.title, str(issue.title, kindLabel));

  const lines: string[] = [
    `${esc("🃏")} *${esc("Decision Needed")}*: *${esc(identifier)}*`,
    `*${esc(title)}*`,
  ];
  const meta: string[] = [`Type: \`${esc(kindLabel)}\``];
  if (requesterName) meta.push(`Requested by: ${esc(requesterName)}`);
  lines.push(meta.join(" \\| "));
  if (interaction.summary) {
    lines.push(`\n${esc(">")} ${esc(str(interaction.summary).slice(0, 300))}`);
  }

  const url = interactionUrl(opts, issue.identifier, interaction.id);
  lines.push(
    url
      ? `\n${esc("Respond on the card:")} [${esc("open decision")}](${url})`
      : `\n${esc("Respond on the card in the web app.")}`,
  );

  const keyboard =
    url && isExternalUrl(opts?.baseUrl)
      ? [[{ text: "Open decision ↗", url }]]
      : undefined;

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(keyboard ? { inlineKeyboard: keyboard } : {}),
    },
  };
}

/**
 * Inbound guard message: a plain-text reply targeting an issue with a pending
 * card must not become a comment (a user comment can supersede a pending
 * card, and the reply text never carries the structured decision).
 */
export function formatPendingInteractionGuardReply(
  issue: InteractionIssueRef,
  pending: IssueThreadInteraction[],
  opts?: IssueLinksOpts,
): { text: string; options: SendMessageOptions } {
  const first = pending[0]!;
  const url = interactionUrl(opts, issue.identifier, first.id);
  const count = pending.length;
  const lines: string[] = [
    `${esc("⚠️")} *${esc("Not posted as a comment.")}*`,
    esc(
      count > 1
        ? `This task has ${count} pending decision cards awaiting a structured response.`
        : "This task has a pending decision card awaiting a structured response.",
    ),
    esc("A comment could cancel the card without carrying your decision."),
  ];
  lines.push(
    url
      ? `${esc("Respond here instead:")} [${esc("open decision")}](${url})`
      : esc("Respond on the card in the web app instead."),
  );
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(url && isExternalUrl(opts?.baseUrl)
        ? { inlineKeyboard: [[{ text: "Open decision ↗", url }]] }
        : {}),
    },
  };
}

function notifiedStateScope(interactionId: string) {
  return {
    scopeKind: "instance",
    stateKey: `interaction_notified_${interactionId}`,
  } as const;
}

async function resolveRequesterName(
  ctx: PluginContext,
  interaction: IssueThreadInteraction,
  companyId: string,
): Promise<string | null> {
  if (interaction.createdByAgentId) {
    try {
      const agent = await ctx.agents.get(interaction.createdByAgentId, companyId);
      if (agent?.name) return agent.name;
    } catch {
      /* best effort */
    }
    return `Agent ${interaction.createdByAgentId.slice(0, 8)}`;
  }
  return null;
}

/**
 * Notify every pending, not-yet-notified interaction card on one issue.
 * Returns the number of Telegram messages sent.
 */
export async function notifyPendingInteractions(
  ctx: PluginContext,
  token: string,
  issue: InteractionIssueRef,
  companyId: string,
  chatId: string,
  opts?: IssueLinksOpts,
  messageThreadId?: number,
): Promise<number> {
  const pending = await getPendingInteractions(ctx, issue.id, companyId);
  let sent = 0;

  for (const interaction of pending) {
    const already = await ctx.state.get(notifiedStateScope(interaction.id));
    if (already) continue;

    const requesterName = await resolveRequesterName(ctx, interaction, companyId);
    const msg = formatPendingInteraction(interaction, issue, requesterName, opts);
    if (messageThreadId) msg.options.messageThreadId = messageThreadId;

    const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);
    if (messageId === null) continue;

    // Mark notified first: a duplicate notification is the failure mode this
    // state exists to prevent, and it is worse than a lost one (the sweep
    // cannot tell a re-send from a first send, the user can).
    await ctx.state.set(notifiedStateScope(interaction.id), {
      notifiedAt: new Date().toISOString(),
      chatId,
      messageId,
    });

    // Map the sent message to the issue so replies to it hit the inbound
    // guard (and, on hosts without interaction support, still route as
    // issue replies).
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `msg_${chatId}_${messageId}` },
      {
        entityId: issue.id,
        entityType: "issue",
        companyId,
        eventType: "interaction.pending",
        interactionId: interaction.id,
      },
    );

    await ctx.activity.log({
      companyId,
      message: `Notified pending ${interaction.kind} interaction to Telegram`,
      entityType: "plugin",
      entityId: issue.id,
    });
    sent++;
  }

  return sent;
}
