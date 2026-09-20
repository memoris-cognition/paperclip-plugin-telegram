import type {
  IssueThreadInteraction,
  AskUserQuestionsPayload,
  AskUserQuestionsAnswer,
  RequestConfirmationPayload,
  RequestCheckboxConfirmationPayload,
  RequestItemVerdictsPayload,
  RequestItemVerdictValue,
  SuggestTasksPayload,
} from "@paperclipai/shared";
import { escapeMarkdownV2 } from "./telegram-api.js";

// ---------------------------------------------------------------------------
// Interactive rendering of pending interaction cards (M1)
//
// Everything in this module is pure: given an interaction payload and the
// current flow state, produce the message text and inline keyboard. All the
// side effects (Telegram calls, Paperclip calls, state persistence) live in
// interaction-callbacks.ts, so this file is directly unit-testable.
//
// Telegram constraints that shape this code:
// - callback_data is limited to 64 bytes, far too small for interaction and
//   option ids. Callback data therefore carries a short per-card token plus
//   an op code and integer indexes; the token resolves to durable flow state.
// - a message keyboard should stay under ~100 buttons. Long option/item lists
//   are truncated and the card links to the web UI for the full list.
// ---------------------------------------------------------------------------

export const CALLBACK_PREFIX = "ix";

/** Keyboard budget: control rows + per-item rows must stay under ~100 buttons. */
export const MAX_KEYBOARD_BUTTONS = 96;
const BUTTON_LABEL_MAX = 48;

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = InlineButton[][];

export type RenderedCard = { text: string; keyboard: InlineKeyboard };

/**
 * Durable state for one rendered interactive card. Keyed by a short random
 * token (`ixflow_<token>` in plugin state) referenced from callback data.
 *
 * The payload is snapshotted at render time so a toggle can re-render the
 * message without re-fetching the interaction (option ids and labels are
 * stable for the lifetime of a pending card).
 */
export type InteractionFlowState = {
  token: string;
  companyId: string;
  issueId: string;
  interactionId: string;
  kind: string;
  chatId: string;
  messageId?: number;
  messageThreadId?: number;
  /** Deep link to the card in the web app, when the host exposes one. */
  webUrl?: string;
  issueIdentifier?: string;
  title?: string;
  payload: unknown;
  /** Selected option ids / task client keys (checkbox + suggest_tasks). */
  selections?: string[];
  /** Item ids already resolved, with their verdict (request_item_verdicts). */
  resolvedVerdicts?: Record<string, RequestItemVerdictValue>;
  /** Current question index and accumulated answers (ask_user_questions). */
  questionIndex?: number;
  answers?: AskUserQuestionsAnswer[];
  /** Toggled option ids for the current multi-select question. */
  questionSelections?: string[];
};

export function newFlowToken(): string {
  // 10 base36 chars: comfortably unique per instance, tiny in callback data.
  let token = "";
  for (let i = 0; i < 10; i++) {
    token += Math.floor(Math.random() * 36).toString(36);
  }
  return token;
}

export function encodeCallback(token: string, op: string, ...args: Array<string | number>): string {
  return [CALLBACK_PREFIX, token, op, ...args.map(String)].join("|");
}

export type ParsedCallback = { token: string; op: string; args: string[] };

export function parseCallback(data: string): ParsedCallback | null {
  const parts = data.split("|");
  if (parts.length < 3 || parts[0] !== CALLBACK_PREFIX) return null;
  return { token: parts[1]!, op: parts[2]!, args: parts.slice(3) };
}

export function isInteractionCallback(data: string): boolean {
  return data.startsWith(`${CALLBACK_PREFIX}|`);
}

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function clipButton(label: string): string {
  if (label.length <= BUTTON_LABEL_MAX) return label;
  return `${label.slice(0, BUTTON_LABEL_MAX - 1)}…`;
}

function isExternalUrl(url?: string): url is string {
  return !!url && url.startsWith("https://");
}

/** Web-link row appended to every card ("always a deep link to the web card"). */
function webLinkRow(state: InteractionFlowState): InlineKeyboard {
  return isExternalUrl(state.webUrl) ? [[{ text: "Open in web app ↗", url: state.webUrl }]] : [];
}

function headerLines(state: InteractionFlowState, kindLabel: string): string[] {
  const lines: string[] = [];
  const identifier = state.issueIdentifier ?? state.issueId;
  lines.push(`${esc("🃏")} *${esc("Decision Needed")}*: *${esc(identifier)}*`);
  if (state.title) lines.push(`*${esc(state.title)}*`);
  lines.push(`Type: \`${esc(kindLabel)}\``);
  return lines;
}

function webLinkLine(state: InteractionFlowState): string {
  return isExternalUrl(state.webUrl)
    ? `${esc("Full card:")} [${esc("open in web app")}](${state.webUrl})`
    : esc("Full card: see the web app.");
}

// ---------------------------------------------------------------------------
// request_confirmation
// ---------------------------------------------------------------------------

export function renderConfirmation(state: InteractionFlowState): RenderedCard {
  const payload = state.payload as RequestConfirmationPayload;
  const lines = headerLines(state, "Confirmation");
  lines.push("", esc(payload.prompt));
  lines.push("", webLinkLine(state));

  const acceptLabel = clipButton(payload.acceptLabel || "Approve");
  const rejectLabel = clipButton(payload.rejectLabel || "Request changes");
  const keyboard: InlineKeyboard = [
    [
      { text: `✅ ${acceptLabel}`, callback_data: encodeCallback(state.token, "ok") },
      { text: `✋ ${rejectLabel}`, callback_data: encodeCallback(state.token, "no") },
    ],
    ...webLinkRow(state),
  ];
  return { text: lines.join("\n"), keyboard };
}

// ---------------------------------------------------------------------------
// request_checkbox_confirmation + suggest_tasks (shared toggle-list shape)
// ---------------------------------------------------------------------------

export type ToggleOption = { id: string; label: string };

/** Normalize both toggle-list kinds to one option list. */
export function toggleOptions(state: InteractionFlowState): ToggleOption[] {
  if (state.kind === "suggest_tasks") {
    const payload = state.payload as SuggestTasksPayload;
    return payload.tasks
      .filter((t) => !t.hiddenInPreview)
      .map((t) => ({ id: t.clientKey, label: t.title }));
  }
  const payload = state.payload as RequestCheckboxConfirmationPayload;
  return payload.options.map((o) => ({ id: o.id, label: o.label }));
}

export function renderToggleList(state: InteractionFlowState): RenderedCard {
  const isSuggest = state.kind === "suggest_tasks";
  const payload = state.payload as RequestCheckboxConfirmationPayload | SuggestTasksPayload;
  const options = toggleOptions(state);
  const selected = new Set(state.selections ?? []);

  const lines = headerLines(state, isSuggest ? "Suggested tasks" : "Checkbox confirmation");
  const prompt = isSuggest
    ? "Toggle the tasks to create, then confirm."
    : (payload as RequestCheckboxConfirmationPayload).prompt;
  lines.push("", esc(prompt));

  // 1 toggle button per option + confirm/reject row + web row.
  const maxOptions = MAX_KEYBOARD_BUTTONS - 3;
  const shown = options.slice(0, maxOptions);
  const truncated = options.length - shown.length;

  const keyboard: InlineKeyboard = shown.map((opt, i) => [
    {
      text: clipButton(`${selected.has(opt.id) ? "☑" : "☐"} ${opt.label}`),
      callback_data: encodeCallback(state.token, "tg", i),
    },
  ]);
  if (truncated > 0) {
    lines.push("", esc(`⚠️ ${truncated} more option(s) not shown — use the web app for the full list.`));
  }

  const checkbox = state.kind === "request_checkbox_confirmation"
    ? (payload as RequestCheckboxConfirmationPayload)
    : null;
  const acceptLabel = clipButton(checkbox?.acceptLabel || (isSuggest ? "Create selected" : "Confirm selection"));
  const rejectLabel = clipButton(checkbox?.rejectLabel || "Request changes");
  keyboard.push([
    { text: `✅ ${acceptLabel} (${selected.size})`, callback_data: encodeCallback(state.token, "ok") },
    { text: `✋ ${rejectLabel}`, callback_data: encodeCallback(state.token, "no") },
  ]);
  keyboard.push(...webLinkRow(state));

  lines.push("", webLinkLine(state));
  return { text: lines.join("\n"), keyboard };
}

/** Bounds from the payload, enforced client-side before calling accept. */
export function checkboxSelectionBounds(state: InteractionFlowState): { min: number; max: number | null } {
  if (state.kind !== "request_checkbox_confirmation") return { min: 0, max: null };
  const payload = state.payload as RequestCheckboxConfirmationPayload;
  return { min: payload.minSelected ?? 0, max: payload.maxSelected ?? null };
}

// ---------------------------------------------------------------------------
// request_item_verdicts
// ---------------------------------------------------------------------------

const VERDICT_MARKS: Record<RequestItemVerdictValue, string> = {
  approve: "✅",
  reject: "❌",
  defer: "⏸",
};

export function renderVerdicts(state: InteractionFlowState): RenderedCard {
  const payload = state.payload as RequestItemVerdictsPayload;
  const resolved = state.resolvedVerdicts ?? {};
  const verdicts = payload.verdicts ?? ["approve", "reject"];

  const lines = headerLines(state, "Item verdicts");
  lines.push("", esc(payload.prompt));

  const buttonsPerItem = verdicts.length;
  const maxItems = Math.max(1, Math.floor((MAX_KEYBOARD_BUTTONS - 1) / buttonsPerItem));
  const shown = payload.items.slice(0, maxItems);
  const truncated = payload.items.length - shown.length;

  const keyboard: InlineKeyboard = [];
  shown.forEach((item, i) => {
    const mark = resolved[item.id] ? ` ${VERDICT_MARKS[resolved[item.id]!]}` : "";
    lines.push("", `${esc(`${i + 1}.`)} *${esc(item.label)}*${esc(mark)}`);
    if (item.description) lines.push(esc(item.description));
    if (resolved[item.id]) return; // already resolved server-side: no buttons
    const row: InlineButton[] = [];
    if (verdicts.includes("approve")) row.push({ text: `✅ ${i + 1}`, callback_data: encodeCallback(state.token, "vd", i, "a") });
    if (verdicts.includes("reject")) row.push({ text: `❌ ${i + 1}`, callback_data: encodeCallback(state.token, "vd", i, "r") });
    if (verdicts.includes("defer")) row.push({ text: `⏸ ${i + 1}`, callback_data: encodeCallback(state.token, "vd", i, "d") });
    keyboard.push(row);
  });

  if (truncated > 0) {
    lines.push("", esc(`⚠️ ${truncated} more item(s) not shown — use the web app for the full list.`));
  }
  keyboard.push(...webLinkRow(state));
  lines.push("", webLinkLine(state));
  return { text: lines.join("\n"), keyboard };
}

export function verdictRequiresReason(state: InteractionFlowState, verdict: RequestItemVerdictValue): boolean {
  const payload = state.payload as RequestItemVerdictsPayload;
  return (payload.requireReasonOn ?? ["reject"]).includes(verdict);
}

// ---------------------------------------------------------------------------
// ask_user_questions — one question at a time
// ---------------------------------------------------------------------------

export function currentQuestion(state: InteractionFlowState) {
  const payload = state.payload as AskUserQuestionsPayload;
  const index = state.questionIndex ?? 0;
  return { payload, index, question: payload.questions[index], total: payload.questions.length };
}

export function renderQuestion(state: InteractionFlowState): RenderedCard {
  const { question, index, total } = currentQuestion(state);
  const lines = headerLines(state, "Questions");
  if (!question) {
    lines.push("", esc("All questions answered."));
    return { text: lines.join("\n"), keyboard: webLinkRow(state) };
  }

  lines.push("", `*${esc(`Question ${index + 1}/${total}`)}*`, esc(question.prompt));
  if (question.helpText) lines.push(esc(question.helpText));

  const isMulti = question.selectionMode === "multi";
  const selected = new Set(state.questionSelections ?? []);
  const maxOptions = MAX_KEYBOARD_BUTTONS - 4;
  const shown = question.options.slice(0, maxOptions);
  if (question.options.length > shown.length) {
    lines.push("", esc(`⚠️ ${question.options.length - shown.length} more option(s) not shown — use the web app.`));
  }

  const keyboard: InlineKeyboard = shown.map((opt, i) => [
    {
      text: clipButton(
        isMulti && !opt.freeText
          ? `${selected.has(opt.id) ? "☑" : "☐"} ${opt.label}`
          : `${opt.freeText ? "✏️ " : ""}${opt.label}`,
      ),
      callback_data: encodeCallback(state.token, "qo", i),
    },
  ]);

  const controls: InlineButton[] = [];
  if (isMulti) {
    controls.push({ text: "Next ▶", callback_data: encodeCallback(state.token, "qn") });
  }
  if (question.allowOther !== false) {
    controls.push({ text: "✏️ Other (free text)", callback_data: encodeCallback(state.token, "qt") });
  }
  if (!question.required) {
    controls.push({ text: "Skip ⏭", callback_data: encodeCallback(state.token, "qs") });
  }
  if (controls.length > 0) keyboard.push(controls);
  keyboard.push(...webLinkRow(state));

  lines.push("", webLinkLine(state));
  return { text: lines.join("\n"), keyboard };
}

// ---------------------------------------------------------------------------
// Kind dispatch
// ---------------------------------------------------------------------------

export const INTERACTIVE_KINDS = new Set([
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "ask_user_questions",
  "suggest_tasks",
]);

export function renderCard(state: InteractionFlowState): RenderedCard {
  switch (state.kind) {
    case "request_confirmation":
      return renderConfirmation(state);
    case "request_checkbox_confirmation":
    case "suggest_tasks":
      return renderToggleList(state);
    case "request_item_verdicts":
      return renderVerdicts(state);
    case "ask_user_questions":
      return renderQuestion(state);
    default:
      throw new Error(`Unsupported interaction kind: ${state.kind}`);
  }
}

// ---------------------------------------------------------------------------
// Terminal rendering (message edited in place once the card is resolved)
// ---------------------------------------------------------------------------

export function renderResolved(
  state: InteractionFlowState,
  outcome: "accepted" | "rejected" | "answered" | "submitted",
  actor: string,
  detail?: string,
): string {
  const identifier = state.issueIdentifier ?? state.issueId;
  const marks: Record<typeof outcome, string> = {
    accepted: "✅ Accepted",
    rejected: "✋ Changes requested",
    answered: "✅ Answers submitted",
    submitted: "✅ Verdicts submitted",
  };
  const lines = [
    `${esc(marks[outcome])} *${esc(identifier)}*${state.title ? `: ${esc(state.title)}` : ""}`,
    esc(`by ${actor}`),
  ];
  if (detail) lines.push(esc(detail));
  if (isExternalUrl(state.webUrl)) {
    lines.push(`[${esc("View the card")}](${state.webUrl})`);
  }
  return lines.join("\n");
}
