import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AskUserQuestionsAnswer,
  RequestConfirmationPayload,
  RequestCheckboxConfirmationPayload,
  RequestItemVerdictsPayload,
  RequestItemVerdictValue,
} from "@paperclipai/shared";
import { sendMessage, editMessage, answerCallbackQuery } from "./telegram-api.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";
import {
  type InteractionFlowState,
  type RenderedCard,
  parseCallback,
  renderToggleList,
  renderVerdicts,
  renderQuestion,
  renderResolved,
  toggleOptions,
  checkboxSelectionBounds,
  currentQuestion,
  verdictRequiresReason,
} from "./interaction-render.js";

// ---------------------------------------------------------------------------
// Interactive card callbacks (M1)
//
// Resolution channels, in order of preference:
// - plain accept/reject: `ctx.issues.respondInteraction` (capability
//   `issue.interactions.respond`), attributed to the paired board user id
//   registered through the board-access action. The host re-verifies that
//   identity server-side, so `human_only` cards stay human-resolved.
// - bodies the SDK cannot carry (selection accepts, question answers, item
//   verdicts): the board REST routes with the board-access API token — the
//   token itself authenticates the paired board user.
// Without either pairing, buttons answer with a pointer to the web card;
// nothing is ever resolved with the plugin's own identity.
// ---------------------------------------------------------------------------

export type InteractionDeps = {
  ctx: PluginContext;
  telegramToken: string;
  /** Paperclip API base URL (host-side), for the board REST routes. */
  apiBaseUrl: string;
  /** Board-access API token (paired board user), when configured. */
  boardApiToken?: string;
  /** Paired board user id, for SDK respondInteraction attribution. */
  boardUserId?: string;
};

const PAIRING_HINT = "Board pairing is not configured — respond on the web card.";

function flowScope(token: string) {
  return { scopeKind: "instance", stateKey: `ixflow_${token}` } as const;
}

function promptScope(chatId: string, messageId: number) {
  return { scopeKind: "instance", stateKey: `msg_${chatId}_${messageId}` } as const;
}

export async function loadFlowState(
  ctx: PluginContext,
  token: string,
): Promise<InteractionFlowState | null> {
  const state = (await ctx.state.get(flowScope(token))) as InteractionFlowState | null;
  return state ?? null;
}

export async function saveFlowState(ctx: PluginContext, state: InteractionFlowState): Promise<void> {
  await ctx.state.set(flowScope(state.token), state);
}

async function clearFlowState(ctx: PluginContext, token: string): Promise<void> {
  await ctx.state.set(flowScope(token), null);
}

/** Mapping stored under a ForceReply prompt message so the reply routes back here. */
export type InteractionPromptMapping = {
  entityType: "interaction_prompt";
  token: string;
  mode: "reject_reason" | "verdict_reason" | "question_text" | "question_option_text";
  itemIndex?: number;
  optionIndex?: number;
  companyId: string;
};

export function isInteractionPromptMapping(value: unknown): value is InteractionPromptMapping {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { entityType?: unknown }).entityType === "interaction_prompt"
  );
}

// ---------------------------------------------------------------------------
// Resolution channels
// ---------------------------------------------------------------------------

class PairingError extends Error {}

async function resolveDecision(
  deps: InteractionDeps,
  state: InteractionFlowState,
  action: "accept" | "reject",
  reason?: string | null,
): Promise<void> {
  if (deps.boardUserId) {
    try {
      await deps.ctx.issues.respondInteraction(
        state.issueId,
        state.interactionId,
        { action, actorUserId: deps.boardUserId, reason: reason ?? null },
        state.companyId,
      );
      return;
    } catch (err) {
      // A stale or malformed paired identity should not strand the card when
      // the board API token can still resolve it as the token's user.
      if (!deps.boardApiToken) throw err;
      deps.ctx.logger.warn("respondInteraction with paired identity failed, falling back to board REST route", {
        interactionId: state.interactionId,
        error: String(err),
      });
    }
  }
  if (deps.boardApiToken) {
    await postInteractionRoute(deps, state, action, reason ? { reason } : {});
    return;
  }
  throw new PairingError(PAIRING_HINT);
}

async function postInteractionRoute(
  deps: InteractionDeps,
  state: InteractionFlowState,
  route: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!deps.boardApiToken) throw new PairingError(PAIRING_HINT);
  await fetchPaperclipApi(
    deps.ctx,
    `${deps.apiBaseUrl}/api/issues/${state.issueId}/interactions/${state.interactionId}/${route}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildPaperclipAuthHeaders(deps.boardApiToken),
      },
      body: JSON.stringify(body),
    },
  );
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

async function redraw(deps: InteractionDeps, state: InteractionFlowState, card: RenderedCard): Promise<void> {
  if (!state.messageId) return;
  await editMessage(deps.ctx, deps.telegramToken, state.chatId, state.messageId, card.text, {
    parseMode: "MarkdownV2",
    inlineKeyboard: card.keyboard,
  });
}

async function finalize(
  deps: InteractionDeps,
  state: InteractionFlowState,
  outcome: "accepted" | "rejected" | "answered" | "submitted",
  actor: string,
  detail?: string,
): Promise<void> {
  if (state.messageId) {
    await editMessage(
      deps.ctx,
      deps.telegramToken,
      state.chatId,
      state.messageId,
      renderResolved(state, outcome, actor, detail),
      { parseMode: "MarkdownV2" },
    );
  }
  await clearFlowState(deps.ctx, state.token);
}

async function sendForceReplyPrompt(
  deps: InteractionDeps,
  state: InteractionFlowState,
  text: string,
  mapping: Omit<InteractionPromptMapping, "entityType" | "token" | "companyId">,
): Promise<void> {
  const messageId = await sendMessage(deps.ctx, deps.telegramToken, state.chatId, text, {
    forceReply: true,
    messageThreadId: state.messageThreadId,
  });
  if (messageId === null) return;
  const full: InteractionPromptMapping = {
    entityType: "interaction_prompt",
    token: state.token,
    companyId: state.companyId,
    ...mapping,
  };
  await deps.ctx.state.set(promptScope(state.chatId, messageId), full);
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

type CallbackQuery = {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
};

/** Company id of the flow behind an `ix|` callback, for board-token resolution. */
export async function interactionCallbackCompanyId(
  ctx: PluginContext,
  data: string,
): Promise<string | null> {
  const parsed = parseCallback(data);
  if (!parsed) return null;
  const state = await loadFlowState(ctx, parsed.token);
  return state?.companyId ?? null;
}

export async function handleInteractionCallback(
  deps: InteractionDeps,
  query: CallbackQuery,
): Promise<void> {
  const { ctx, telegramToken } = deps;
  const parsed = query.data ? parseCallback(query.data) : null;
  if (!parsed) {
    await answerCallbackQuery(ctx, telegramToken, query.id, "Unknown action");
    return;
  }

  const state = await loadFlowState(ctx, parsed.token);
  if (!state) {
    await answerCallbackQuery(ctx, telegramToken, query.id, "This card is no longer active — use the web app.");
    return;
  }
  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);

  try {
    switch (state.kind) {
      case "request_confirmation":
        await handleConfirmationOp(deps, state, parsed.op, actor, query.id);
        return;
      case "request_checkbox_confirmation":
      case "suggest_tasks":
        await handleToggleListOp(deps, state, parsed.op, parsed.args, actor, query.id);
        return;
      case "request_item_verdicts":
        await handleVerdictOp(deps, state, parsed.op, parsed.args, actor, query.id);
        return;
      case "ask_user_questions":
        await handleQuestionOp(deps, state, parsed.op, parsed.args, actor, query.id);
        return;
      default:
        await answerCallbackQuery(ctx, telegramToken, query.id, "Unsupported card type — use the web app.");
    }
  } catch (err) {
    const message = err instanceof PairingError ? err.message : `Failed: ${String(err).slice(0, 150)}`;
    ctx.logger.error("Interaction callback failed", {
      interactionId: state.interactionId,
      op: parsed.op,
      error: String(err),
    });
    await answerCallbackQuery(ctx, telegramToken, query.id, message);
  }
}

// --- request_confirmation ---------------------------------------------------

async function handleConfirmationOp(
  deps: InteractionDeps,
  state: InteractionFlowState,
  op: string,
  actor: string,
  callbackQueryId: string,
): Promise<void> {
  const payload = state.payload as RequestConfirmationPayload;
  if (op === "ok") {
    await resolveDecision(deps, state, "accept");
    await answerCallbackQuery(deps.ctx, deps.telegramToken, callbackQueryId, "Accepted");
    await finalize(deps, state, "accepted", actor);
    return;
  }
  if (op === "no") {
    await beginRejectFlow(deps, state, payload, actor, callbackQueryId);
    return;
  }
  await answerCallbackQuery(deps.ctx, deps.telegramToken, callbackQueryId, "Unknown action");
}

/** Shared by confirmation and toggle-list rejects: collect the reason via ForceReply. */
async function beginRejectFlow(
  deps: InteractionDeps,
  state: InteractionFlowState,
  payload: Pick<RequestConfirmationPayload, "rejectRequiresReason" | "allowDeclineReason" | "rejectReasonLabel">,
  actor: string,
  callbackQueryId: string,
): Promise<void> {
  if (payload.allowDeclineReason === false && !payload.rejectRequiresReason) {
    await resolveDecision(deps, state, "reject");
    await answerCallbackQuery(deps.ctx, deps.telegramToken, callbackQueryId, "Rejected");
    await finalize(deps, state, "rejected", actor);
    return;
  }
  const label = payload.rejectReasonLabel || "What should change?";
  const optionalHint = payload.rejectRequiresReason ? "" : ' Send "-" to reject without a reason.';
  await sendForceReplyPrompt(
    deps,
    state,
    `✋ ${label}\nReply to this message with the reason.${optionalHint}`,
    { mode: "reject_reason" },
  );
  await answerCallbackQuery(deps.ctx, deps.telegramToken, callbackQueryId, "Reply with the reason");
}

// --- checkbox confirmation + suggest_tasks ----------------------------------

async function handleToggleListOp(
  deps: InteractionDeps,
  state: InteractionFlowState,
  op: string,
  args: string[],
  actor: string,
  callbackQueryId: string,
): Promise<void> {
  const { ctx, telegramToken } = deps;
  const options = toggleOptions(state);

  if (op === "tg") {
    const index = Number(args[0]);
    const option = options[index];
    if (!option) {
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Unknown option");
      return;
    }
    const selections = new Set(state.selections ?? []);
    if (selections.has(option.id)) selections.delete(option.id);
    else selections.add(option.id);
    state.selections = options.map((o) => o.id).filter((id) => selections.has(id));
    await saveFlowState(ctx, state);
    await redraw(deps, state, renderToggleList(state));
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "");
    return;
  }

  if (op === "ok") {
    const selections = state.selections ?? [];
    const bounds = checkboxSelectionBounds(state);
    if (selections.length < bounds.min) {
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, `Select at least ${bounds.min} option(s).`);
      return;
    }
    if (bounds.max !== null && selections.length > bounds.max) {
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, `Select at most ${bounds.max} option(s).`);
      return;
    }
    const body =
      state.kind === "suggest_tasks"
        ? { selectedClientKeys: selections }
        : { selectedOptionIds: selections };
    await postInteractionRoute(deps, state, "accept", body);
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Accepted");
    await finalize(deps, state, "accepted", actor, `${selections.length} selected`);
    return;
  }

  if (op === "no") {
    const payload =
      state.kind === "request_checkbox_confirmation"
        ? (state.payload as RequestCheckboxConfirmationPayload)
        : { rejectRequiresReason: false, allowDeclineReason: true, rejectReasonLabel: null };
    await beginRejectFlow(deps, state, payload, actor, callbackQueryId);
    return;
  }

  await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Unknown action");
}

// --- item verdicts -----------------------------------------------------------

const VERDICT_BY_CODE: Record<string, RequestItemVerdictValue> = {
  a: "approve",
  r: "reject",
  d: "defer",
};

async function handleVerdictOp(
  deps: InteractionDeps,
  state: InteractionFlowState,
  op: string,
  args: string[],
  actor: string,
  callbackQueryId: string,
): Promise<void> {
  const { ctx, telegramToken } = deps;
  if (op !== "vd") {
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Unknown action");
    return;
  }
  const payload = state.payload as RequestItemVerdictsPayload;
  const index = Number(args[0]);
  const verdict = VERDICT_BY_CODE[args[1] ?? ""];
  const item = payload.items[index];
  if (!item || !verdict) {
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Unknown item");
    return;
  }
  if ((state.resolvedVerdicts ?? {})[item.id]) {
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Already resolved");
    return;
  }

  if (verdictRequiresReason(state, verdict)) {
    const label = payload.reasonLabel || "What should change?";
    await sendForceReplyPrompt(
      deps,
      state,
      `${verdict === "reject" ? "❌" : "✏️"} ${item.label}\n${label}\nReply to this message with the reason.`,
      { mode: "verdict_reason", itemIndex: index },
    );
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Reply with the reason");
    return;
  }

  await submitVerdict(deps, state, item.id, verdict, undefined, actor);
  await answerCallbackQuery(ctx, telegramToken, callbackQueryId, `${verdict} — submitted`);
}

async function submitVerdict(
  deps: InteractionDeps,
  state: InteractionFlowState,
  itemId: string,
  verdict: RequestItemVerdictValue,
  reason: string | undefined,
  actor: string,
): Promise<void> {
  const payload = state.payload as RequestItemVerdictsPayload;
  await postInteractionRoute(deps, state, "verdicts", {
    verdicts: [{ id: itemId, verdict, ...(reason ? { reason } : {}) }],
  });
  state.resolvedVerdicts = { ...(state.resolvedVerdicts ?? {}), [itemId]: verdict };
  const complete = payload.items.every((i) => state.resolvedVerdicts![i.id]);
  if (complete) {
    await finalize(deps, state, "submitted", actor, `${payload.items.length} item(s) resolved`);
    return;
  }
  await saveFlowState(deps.ctx, state);
  await redraw(deps, state, renderVerdicts(state));
}

// --- ask_user_questions --------------------------------------------------------

async function handleQuestionOp(
  deps: InteractionDeps,
  state: InteractionFlowState,
  op: string,
  args: string[],
  actor: string,
  callbackQueryId: string,
): Promise<void> {
  const { ctx, telegramToken } = deps;
  const { question } = currentQuestion(state);
  if (!question) {
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "No question pending");
    return;
  }

  if (op === "qo") {
    const option = question.options[Number(args[0])];
    if (!option) {
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Unknown option");
      return;
    }
    if (option.freeText) {
      await sendForceReplyPrompt(deps, state, `✏️ ${option.label}\nReply to this message with your answer.`, {
        mode: "question_option_text",
        optionIndex: Number(args[0]),
      });
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Reply with your answer");
      return;
    }
    if (question.selectionMode === "multi") {
      const selections = new Set(state.questionSelections ?? []);
      if (selections.has(option.id)) selections.delete(option.id);
      else selections.add(option.id);
      state.questionSelections = question.options.map((o) => o.id).filter((id) => selections.has(id));
      await saveFlowState(ctx, state);
      await redraw(deps, state, renderQuestion(state));
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "");
      return;
    }
    await recordAnswerAndAdvance(deps, state, { questionId: question.id, optionIds: [option.id] }, actor);
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Recorded");
    return;
  }

  if (op === "qn") {
    const optionIds = state.questionSelections ?? [];
    if (question.required && optionIds.length === 0) {
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "This question is required — pick at least one option.");
      return;
    }
    await recordAnswerAndAdvance(deps, state, { questionId: question.id, optionIds }, actor);
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Recorded");
    return;
  }

  if (op === "qt") {
    await sendForceReplyPrompt(deps, state, `✏️ ${question.prompt}\nReply to this message with your answer.`, {
      mode: "question_text",
    });
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Reply with your answer");
    return;
  }

  if (op === "qs") {
    if (question.required) {
      await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "This question is required.");
      return;
    }
    await recordAnswerAndAdvance(deps, state, { questionId: question.id, optionIds: [] }, actor);
    await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Skipped");
    return;
  }

  await answerCallbackQuery(ctx, telegramToken, callbackQueryId, "Unknown action");
}

/**
 * Record one answer, then either show the next question or submit all answers
 * with a single `respond` call (the card is resolved exactly once, at the end).
 */
async function recordAnswerAndAdvance(
  deps: InteractionDeps,
  state: InteractionFlowState,
  answer: AskUserQuestionsAnswer,
  actor: string,
): Promise<void> {
  const { payload, index, total } = currentQuestion(state);
  state.answers = [...(state.answers ?? []).filter((a) => a.questionId !== answer.questionId), answer];
  state.questionIndex = index + 1;
  state.questionSelections = [];

  if (state.questionIndex >= total) {
    await postInteractionRoute(deps, state, "respond", { answers: state.answers });
    await finalize(deps, state, "answered", actor, `${payload.questions.length} question(s) answered`);
    return;
  }
  await saveFlowState(deps.ctx, state);
  await redraw(deps, state, renderQuestion(state));
}

// ---------------------------------------------------------------------------
// ForceReply prompt replies (reject reasons, free-text answers)
// ---------------------------------------------------------------------------

export async function handleInteractionPromptReply(
  deps: InteractionDeps,
  mapping: InteractionPromptMapping,
  /** Message id of the ForceReply prompt the user replied to. */
  promptMessageId: number,
  message: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string; first_name?: string };
  },
): Promise<void> {
  const { ctx, telegramToken } = deps;
  const chatId = String(message.chat.id);
  const text = (message.text ?? "").trim();
  const actor = message.from?.username ?? message.from?.first_name ?? String(message.from?.id ?? chatId);

  const state = await loadFlowState(ctx, mapping.token);
  if (!state) {
    await sendMessage(ctx, telegramToken, chatId, "This card is no longer active — use the web app.", {
      replyToMessageId: message.message_id,
    });
    return;
  }

  // Validation retries keep the mapping alive so the user can reply to the
  // same prompt again; every other outcome consumes it.
  let keepPrompt = false;
  try {
    if (mapping.mode === "reject_reason") {
      const reason = text === "-" ? null : text;
      const payload = state.payload as RequestConfirmationPayload;
      if (payload.rejectRequiresReason && !reason) {
        keepPrompt = true;
        await sendMessage(ctx, telegramToken, chatId, "A reason is required — reply to the prompt again.", {
          replyToMessageId: message.message_id,
        });
        return;
      }
      await resolveDecision(deps, state, "reject", reason);
      await finalize(deps, state, "rejected", actor, reason ?? undefined);
      return;
    }

    if (mapping.mode === "verdict_reason") {
      const payload = state.payload as RequestItemVerdictsPayload;
      const item = payload.items[mapping.itemIndex ?? -1];
      if (!item) return;
      if (!text) {
        keepPrompt = true;
        await sendMessage(ctx, telegramToken, chatId, "A reason is required — reply to the prompt again.", {
          replyToMessageId: message.message_id,
        });
        return;
      }
      await submitVerdict(deps, state, item.id, "reject", text, actor);
      return;
    }

    if (mapping.mode === "question_text" || mapping.mode === "question_option_text") {
      const { question } = currentQuestion(state);
      if (!question) return;
      if (!text) {
        keepPrompt = true;
        await sendMessage(ctx, telegramToken, chatId, "Empty answer — reply to the prompt again.", {
          replyToMessageId: message.message_id,
        });
        return;
      }
      const option =
        mapping.mode === "question_option_text" ? question.options[mapping.optionIndex ?? -1] : undefined;
      await recordAnswerAndAdvance(
        deps,
        state,
        { questionId: question.id, optionIds: option ? [option.id] : [], otherText: text },
        actor,
      );
      return;
    }
  } catch (err) {
    const hint = err instanceof PairingError ? err.message : `Failed to submit: ${String(err).slice(0, 200)}`;
    ctx.logger.error("Interaction prompt reply failed", {
      interactionId: state.interactionId,
      mode: mapping.mode,
      error: String(err),
    });
    keepPrompt = true; // transient failure: let the user reply again
    await sendMessage(ctx, telegramToken, chatId, hint, { replyToMessageId: message.message_id });
  } finally {
    if (!keepPrompt) {
      await ctx.state.set(promptScope(chatId, promptMessageId), null);
    }
  }
}
