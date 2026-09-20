import { describe, it, expect } from "vitest";
import {
  encodeCallback,
  parseCallback,
  isInteractionCallback,
  newFlowToken,
  renderCard,
  renderConfirmation,
  renderToggleList,
  renderVerdicts,
  renderQuestion,
  renderResolved,
  toggleOptions,
  checkboxSelectionBounds,
  verdictRequiresReason,
  MAX_KEYBOARD_BUTTONS,
  type InteractionFlowState,
} from "../src/interaction-render.js";

// Pure rendering coverage: text content, keyboard shape, callback data
// encoding, defaults, and truncation against the Telegram button budget.

function flowState(overrides: Partial<InteractionFlowState> = {}): InteractionFlowState {
  return {
    token: "tok1234567",
    companyId: "company-a",
    issueId: "issue-1",
    interactionId: "int-1",
    kind: "request_confirmation",
    chatId: "42",
    messageId: 100,
    webUrl: "https://paperclip.example/ACM/issues/ACM-7#interaction-int-1",
    issueIdentifier: "ACM-7",
    title: "Approve the plan",
    payload: { version: 1, prompt: "Approve?" },
    ...overrides,
  };
}

function countButtons(keyboard: Array<Array<unknown>>): number {
  return keyboard.reduce((n, row) => n + row.length, 0);
}

describe("callback data codec", () => {
  it("round-trips op and args and stays under Telegram's 64-byte limit", () => {
    const data = encodeCallback("tok1234567", "vd", 42, "r");
    expect(data).toBe("ix|tok1234567|vd|42|r");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({ token: "tok1234567", op: "vd", args: ["42", "r"] });
  });

  it("isInteractionCallback discriminates from legacy callback formats", () => {
    expect(isInteractionCallback("ix|tok|ok")).toBe(true);
    expect(isInteractionCallback("approve_abc")).toBe(false);
    expect(isInteractionCallback("esc_defer_x")).toBe(false);
  });

  it("parseCallback rejects malformed data", () => {
    expect(parseCallback("approve_abc")).toBeNull();
    expect(parseCallback("ix|only-token")).toBeNull();
  });

  it("newFlowToken emits distinct short tokens", () => {
    const a = newFlowToken();
    const b = newFlowToken();
    expect(a).toMatch(/^[a-z0-9]{10}$/);
    expect(a).not.toBe(b);
  });
});

describe("request_confirmation rendering", () => {
  it("renders prompt, accept/reject buttons, and the web deep link", () => {
    const card = renderConfirmation(flowState());
    expect(card.text).toContain("Approve?");
    expect(card.text).toContain("ACM\\-7");
    const [row] = card.keyboard;
    expect(row?.[0]?.text).toContain("Approve");
    expect(row?.[0]?.callback_data).toBe("ix|tok1234567|ok");
    expect(row?.[1]?.text).toContain("Request changes");
    expect(row?.[1]?.callback_data).toBe("ix|tok1234567|no");
    expect(card.keyboard.at(-1)?.[0]?.url).toContain("#interaction-int-1");
  });

  it("uses payload labels when provided", () => {
    const card = renderConfirmation(
      flowState({ payload: { version: 1, prompt: "Go?", acceptLabel: "Ship it", rejectLabel: "Hold on" } }),
    );
    expect(card.keyboard[0]?.[0]?.text).toContain("Ship it");
    expect(card.keyboard[0]?.[1]?.text).toContain("Hold on");
  });

  it("omits the URL button row when the base URL is not external https", () => {
    const card = renderConfirmation(flowState({ webUrl: undefined }));
    expect(card.keyboard).toHaveLength(1);
  });
});

describe("checkbox confirmation + suggest_tasks rendering", () => {
  const checkboxState = (selections: string[] = []) =>
    flowState({
      kind: "request_checkbox_confirmation",
      selections,
      payload: {
        version: 1,
        prompt: "Pick files",
        options: [
          { id: "a", label: "File A" },
          { id: "b", label: "File B" },
        ],
        minSelected: 1,
        maxSelected: 1,
      },
    });

  it("marks selected options and counts them on the confirm button", () => {
    const card = renderToggleList(checkboxState(["b"]));
    expect(card.keyboard[0]?.[0]?.text).toBe("☐ File A");
    expect(card.keyboard[1]?.[0]?.text).toBe("☑ File B");
    expect(card.keyboard[0]?.[0]?.callback_data).toBe("ix|tok1234567|tg|0");
    const confirmRow = card.keyboard[2]!;
    expect(confirmRow[0]?.text).toContain("(1)");
    expect(confirmRow[0]?.callback_data).toBe("ix|tok1234567|ok");
    expect(confirmRow[1]?.callback_data).toBe("ix|tok1234567|no");
  });

  it("exposes payload selection bounds", () => {
    expect(checkboxSelectionBounds(checkboxState())).toEqual({ min: 1, max: 1 });
  });

  it("suggest_tasks maps tasks to toggle options by clientKey, hiding hidden previews", () => {
    const state = flowState({
      kind: "suggest_tasks",
      selections: ["t1"],
      payload: {
        version: 1,
        tasks: [
          { clientKey: "t1", title: "Task one" },
          { clientKey: "t2", title: "Task two", hiddenInPreview: true },
        ],
      },
    });
    expect(toggleOptions(state)).toEqual([{ id: "t1", label: "Task one" }]);
    const card = renderToggleList(state);
    expect(card.keyboard[0]?.[0]?.text).toBe("☑ Task one");
    expect(card.keyboard[1]?.[0]?.text).toContain("Create selected");
  });

  it("truncates long option lists under the button budget and says so", () => {
    const options = Array.from({ length: 150 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const card = renderToggleList(
      flowState({
        kind: "request_checkbox_confirmation",
        payload: { version: 1, prompt: "Pick", options },
      }),
    );
    expect(countButtons(card.keyboard)).toBeLessThanOrEqual(MAX_KEYBOARD_BUTTONS);
    expect(card.text).toContain("not shown");
  });
});

describe("item verdicts rendering", () => {
  const verdictState = (overrides: Partial<InteractionFlowState> = {}) =>
    flowState({
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review artifacts",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs update" },
        ],
        verdicts: ["approve", "reject", "defer"],
        requireReasonOn: ["reject"],
      },
      ...overrides,
    });

  it("renders one verdict row per unresolved item", () => {
    const card = renderVerdicts(verdictState());
    expect(card.keyboard[0]).toHaveLength(3);
    expect(card.keyboard[0]?.[0]?.callback_data).toBe("ix|tok1234567|vd|0|a");
    expect(card.keyboard[0]?.[1]?.callback_data).toBe("ix|tok1234567|vd|0|r");
    expect(card.keyboard[0]?.[2]?.callback_data).toBe("ix|tok1234567|vd|0|d");
    expect(card.keyboard[1]?.[0]?.callback_data).toBe("ix|tok1234567|vd|1|a");
  });

  it("drops buttons for already-resolved items and marks them in the text", () => {
    const card = renderVerdicts(verdictState({ resolvedVerdicts: { api: "approve" } }));
    // one unresolved item row + web link row
    expect(card.keyboard.filter((row) => row[0]?.callback_data)).toHaveLength(1);
    expect(card.text).toContain("✅");
  });

  it("omits the defer button when the payload does not allow it", () => {
    const card = renderVerdicts(
      verdictState({
        payload: {
          version: 1,
          prompt: "Review",
          items: [{ id: "a", label: "A" }],
          verdicts: ["approve", "reject"],
        },
      }),
    );
    expect(card.keyboard[0]).toHaveLength(2);
  });

  it("truncates long item lists under the button budget", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));
    const card = renderVerdicts(
      verdictState({ payload: { version: 1, prompt: "Review", items, verdicts: ["approve", "reject", "defer"] } }),
    );
    expect(countButtons(card.keyboard)).toBeLessThanOrEqual(MAX_KEYBOARD_BUTTONS + 1);
    expect(card.text).toContain("not shown");
  });

  it("verdictRequiresReason follows requireReasonOn with its reject default", () => {
    expect(verdictRequiresReason(verdictState(), "reject")).toBe(true);
    expect(verdictRequiresReason(verdictState(), "approve")).toBe(false);
    const noConfig = verdictState({
      payload: { version: 1, prompt: "R", items: [{ id: "a", label: "A" }] },
    });
    expect(verdictRequiresReason(noConfig, "reject")).toBe(true);
  });
});

describe("ask_user_questions rendering (one question at a time)", () => {
  const questionsState = (overrides: Partial<InteractionFlowState> = {}) =>
    flowState({
      kind: "ask_user_questions",
      questionIndex: 0,
      answers: [],
      payload: {
        version: 1,
        questions: [
          {
            id: "q1",
            prompt: "Which env?",
            selectionMode: "single",
            required: true,
            allowOther: false,
            options: [
              { id: "dev", label: "Dev" },
              { id: "prod", label: "Prod" },
            ],
          },
          {
            id: "q2",
            prompt: "Which features?",
            selectionMode: "multi",
            required: false,
            options: [{ id: "f1", label: "Feature 1" }],
          },
        ],
      },
      ...overrides,
    });

  it("shows the current question with a progress counter and option buttons", () => {
    const card = renderQuestion(questionsState());
    expect(card.text).toContain("Question 1/2");
    expect(card.text).toContain("Which env?");
    expect(card.keyboard[0]?.[0]?.callback_data).toBe("ix|tok1234567|qo|0");
    // single-select + allowOther:false + required: no control row beyond options
    const controls = card.keyboard.flat().map((b) => b.callback_data);
    expect(controls).not.toContain("ix|tok1234567|qn");
    expect(controls).not.toContain("ix|tok1234567|qt");
    expect(controls).not.toContain("ix|tok1234567|qs");
  });

  it("multi-select questions get toggle marks, Next, free text, and Skip controls", () => {
    const card = renderQuestion(questionsState({ questionIndex: 1, questionSelections: ["f1"] }));
    expect(card.text).toContain("Question 2/2");
    expect(card.keyboard[0]?.[0]?.text).toBe("☑ Feature 1");
    const controls = card.keyboard.flat().map((b) => b.callback_data);
    expect(controls).toContain("ix|tok1234567|qn");
    expect(controls).toContain("ix|tok1234567|qt");
    expect(controls).toContain("ix|tok1234567|qs");
  });
});

describe("renderCard dispatch and terminal rendering", () => {
  it("routes each kind to its renderer and rejects unknown kinds", () => {
    expect(renderCard(flowState()).keyboard[0]?.[0]?.callback_data).toBe("ix|tok1234567|ok");
    expect(() => renderCard(flowState({ kind: "connection_intent" }))).toThrow(/Unsupported/);
  });

  it("renderResolved names the outcome, actor, and keeps the web link", () => {
    const text = renderResolved(flowState(), "rejected", "greg", "needs work");
    expect(text).toContain("Changes requested");
    expect(text).toContain("greg");
    expect(text).toContain("needs work");
    expect(text).toContain("#interaction-int-1");
  });
});
