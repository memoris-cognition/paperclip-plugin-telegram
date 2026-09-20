import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { InteractionFlowState } from "../src/interaction-render.js";
import type { InteractionDeps } from "../src/interaction-callbacks.js";

// Callback dispatch coverage: resolution channel choice (SDK vs board REST),
// toggle/verdict/question state machines, ForceReply reason and free-text
// flows, and the pairing guard when neither channel is configured.

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string; options?: Record<string, unknown> }> = [];
let callbackAnswers: string[] = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  let nextMessageId = 500;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return nextMessageId++;
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
      editedMessages.push({ chatId, messageId, text, options });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_ctx: unknown, _token: string, _id: string, text: string) => {
      callbackAnswers.push(text);
    }),
  };
});

function makeCtx() {
  const stateStore = new Map<string, unknown>();
  const stateKey = (scope: { scopeKind: string; scopeId?: string; stateKey: string }) =>
    `${scope.scopeKind}|${scope.scopeId ?? ""}|${scope.stateKey}`;
  const apiCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

  const ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(async (scope: Parameters<typeof stateKey>[0]) => stateStore.get(stateKey(scope)) ?? null),
      set: vi.fn(async (scope: Parameters<typeof stateKey>[0], value: unknown) => {
        stateStore.set(stateKey(scope), value);
      }),
    },
    http: {
      fetch: vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        apiCalls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
          headers: init?.headers ?? {},
        });
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
      }),
    },
    issues: {
      respondInteraction: vi.fn().mockResolvedValue({ interaction: {}, applied: true }),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as PluginContext;

  return { ctx, stateStore, apiCalls };
}

function makeDeps(ctx: PluginContext, overrides: Partial<InteractionDeps> = {}): InteractionDeps {
  return {
    ctx,
    telegramToken: "bot-token",
    apiBaseUrl: "https://paperclip.example",
    boardApiToken: "board-token",
    boardUserId: "user-greg",
    ...overrides,
  };
}

function baseState(overrides: Partial<InteractionFlowState> = {}): InteractionFlowState {
  return {
    token: "tok1234567",
    companyId: "company-a",
    issueId: "issue-1",
    interactionId: "int-1",
    kind: "request_confirmation",
    chatId: "42",
    messageId: 100,
    issueIdentifier: "ACM-7",
    title: "Approve the plan",
    payload: { version: 1, prompt: "Approve?" },
    ...overrides,
  };
}

async function seedState(ctx: PluginContext, state: InteractionFlowState) {
  const { saveFlowState } = await import("../src/interaction-callbacks.js");
  await saveFlowState(ctx, state);
}


/** The prompt-message ids in the mocked sendMessage increment across tests; find the mapping by scanning. */
function findPromptMapping(stateStore: Map<string, unknown>): { key: string; messageId: number; mapping: unknown } {
  for (const [key, value] of stateStore) {
    if (value && typeof value === "object" && (value as { entityType?: string }).entityType === "interaction_prompt") {
      const messageId = Number(key.split("_").pop());
      return { key, messageId, mapping: value };
    }
  }
  throw new Error("no interaction prompt mapping stored");
}

function query(data: string, messageId = 100) {
  return {
    id: "cbq-1",
    from: { id: 7, username: "greg" },
    message: { message_id: messageId, chat: { id: 42 } },
    data,
  };
}

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  callbackAnswers = [];
  vi.clearAllMocks();
});

describe("request_confirmation callbacks", () => {
  it("accept resolves through the SDK with the paired board user id", async () => {
    const { ctx } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, baseState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|ok"));

    expect(ctx.issues.respondInteraction).toHaveBeenCalledWith(
      "issue-1",
      "int-1",
      { action: "accept", actorUserId: "user-greg", reason: null },
      "company-a",
    );
    expect(editedMessages[0]?.text).toContain("Accepted");
    expect(editedMessages[0]?.text).toContain("greg");
  });

  it("reject sends a ForceReply prompt and resolves with the replied reason — never a comment", async () => {
    const { ctx, stateStore } = makeCtx();
    const { handleInteractionCallback, handleInteractionPromptReply, isInteractionPromptMapping } =
      await import("../src/interaction-callbacks.js");
    await seedState(ctx, baseState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|no"));

    expect(sentMessages[0]?.options?.forceReply).toBe(true);
    const { key, messageId, mapping } = findPromptMapping(stateStore);
    expect(isInteractionPromptMapping(mapping)).toBe(true);

    await handleInteractionPromptReply(
      makeDeps(ctx),
      mapping as Parameters<typeof handleInteractionPromptReply>[1],
      messageId,
      { message_id: 501, chat: { id: 42 }, text: "Please split the PR.", from: { id: 7, username: "greg" } },
    );

    expect(ctx.issues.respondInteraction).toHaveBeenCalledWith(
      "issue-1",
      "int-1",
      { action: "reject", actorUserId: "user-greg", reason: "Please split the PR." },
      "company-a",
    );
    // the prompt mapping is consumed
    expect(stateStore.get(key)).toBeNull();
    expect(editedMessages[0]?.text).toContain("Changes requested");
  });

  it("required reason rejects an empty reply and keeps the prompt alive", async () => {
    const { ctx, stateStore } = makeCtx();
    const { handleInteractionCallback, handleInteractionPromptReply } =
      await import("../src/interaction-callbacks.js");
    await seedState(
      ctx,
      baseState({ payload: { version: 1, prompt: "Approve?", rejectRequiresReason: true } }),
    );

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|no"));
    const { key, messageId, mapping } = findPromptMapping(stateStore);

    await handleInteractionPromptReply(
      makeDeps(ctx),
      mapping as Parameters<typeof handleInteractionPromptReply>[1],
      messageId,
      { message_id: 501, chat: { id: 42 }, text: "-", from: { id: 7, username: "greg" } },
    );

    expect(ctx.issues.respondInteraction).not.toHaveBeenCalled();
    expect(stateStore.get(key)).not.toBeNull();
    expect(sentMessages.at(-1)?.text).toContain("reason is required");
  });

  it("falls back to the board REST route when no paired user id is registered", async () => {
    const { ctx, apiCalls } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, baseState());

    await handleInteractionCallback(makeDeps(ctx, { boardUserId: undefined }), query("ix|tok1234567|ok"));

    expect(ctx.issues.respondInteraction).not.toHaveBeenCalled();
    expect(apiCalls[0]?.url).toBe("https://paperclip.example/api/issues/issue-1/interactions/int-1/accept");
    expect(apiCalls[0]?.headers.Authorization).toBe("Bearer board-token");
  });

  it("without any board pairing the button answers with a web pointer and resolves nothing", async () => {
    const { ctx, apiCalls } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, baseState());

    await handleInteractionCallback(
      makeDeps(ctx, { boardUserId: undefined, boardApiToken: undefined }),
      query("ix|tok1234567|ok"),
    );

    expect(ctx.issues.respondInteraction).not.toHaveBeenCalled();
    expect(apiCalls).toHaveLength(0);
    expect(callbackAnswers[0]).toContain("web card");
  });

  it("an expired flow token answers with a web pointer", async () => {
    const { ctx } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await handleInteractionCallback(makeDeps(ctx), query("ix|unknowntok|ok"));
    expect(callbackAnswers[0]).toContain("no longer active");
  });
});

describe("checkbox confirmation + suggest_tasks callbacks", () => {
  const checkboxState = () =>
    baseState({
      kind: "request_checkbox_confirmation",
      selections: [],
      payload: {
        version: 1,
        prompt: "Pick files",
        options: [
          { id: "a", label: "File A" },
          { id: "b", label: "File B" },
        ],
        minSelected: 1,
      },
    });

  it("toggle redraws the message and persists the selection", async () => {
    const { ctx, stateStore } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, checkboxState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|tg|1"));

    const state = stateStore.get("instance||ixflow_tok1234567") as InteractionFlowState;
    expect(state.selections).toEqual(["b"]);
    const keyboard = editedMessages[0]?.options?.inlineKeyboard as Array<Array<{ text: string }>>;
    expect(keyboard[1]?.[0]?.text).toBe("☑ File B");
  });

  it("confirm below minSelected is refused client-side", async () => {
    const { ctx, apiCalls } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, checkboxState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|ok"));

    expect(apiCalls).toHaveLength(0);
    expect(callbackAnswers[0]).toContain("at least 1");
  });

  it("confirm posts selectedOptionIds to the accept route", async () => {
    const { ctx, apiCalls } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, { ...checkboxState(), selections: ["a"] });

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|ok"));

    expect(apiCalls[0]?.url).toContain("/interactions/int-1/accept");
    expect(apiCalls[0]?.body).toEqual({ selectedOptionIds: ["a"] });
    expect(editedMessages[0]?.text).toContain("Accepted");
  });

  it("suggest_tasks confirm posts selectedClientKeys instead", async () => {
    const { ctx, apiCalls } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(
      ctx,
      baseState({
        kind: "suggest_tasks",
        selections: ["t1", "t2"],
        payload: { version: 1, tasks: [{ clientKey: "t1", title: "One" }, { clientKey: "t2", title: "Two" }] },
      }),
    );

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|ok"));

    expect(apiCalls[0]?.body).toEqual({ selectedClientKeys: ["t1", "t2"] });
  });
});

describe("item verdict callbacks", () => {
  const verdictState = () =>
    baseState({
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
    });

  it("approve submits one partial verdict and redraws with the item resolved", async () => {
    const { ctx, apiCalls, stateStore } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, verdictState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|vd|0|a"));

    expect(apiCalls[0]?.url).toContain("/interactions/int-1/verdicts");
    expect(apiCalls[0]?.body).toEqual({ verdicts: [{ id: "api", verdict: "approve" }] });
    const state = stateStore.get("instance||ixflow_tok1234567") as InteractionFlowState;
    expect(state.resolvedVerdicts).toEqual({ api: "approve" });
    expect(editedMessages).toHaveLength(1); // partial: card redrawn, not finalized
  });

  it("reject collects the reason via ForceReply before submitting", async () => {
    const { ctx, apiCalls, stateStore } = makeCtx();
    const { handleInteractionCallback, handleInteractionPromptReply } =
      await import("../src/interaction-callbacks.js");
    await seedState(ctx, verdictState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|vd|1|r"));
    expect(apiCalls).toHaveLength(0);
    expect(sentMessages[0]?.options?.forceReply).toBe(true);

    const { messageId, mapping } = findPromptMapping(stateStore);
    await handleInteractionPromptReply(
      makeDeps(ctx),
      mapping as Parameters<typeof handleInteractionPromptReply>[1],
      messageId,
      { message_id: 501, chat: { id: 42 }, text: "Missing install steps.", from: { id: 7, username: "greg" } },
    );

    expect(apiCalls[0]?.body).toEqual({
      verdicts: [{ id: "docs", verdict: "reject", reason: "Missing install steps." }],
    });
  });

  it("finalizes the card once every item is resolved", async () => {
    const { ctx, stateStore } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, { ...verdictState(), resolvedVerdicts: { docs: "defer" } });

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|vd|0|a"));

    expect(editedMessages[0]?.text).toContain("Verdicts submitted");
    expect(stateStore.get("instance||ixflow_tok1234567")).toBeNull();
  });

  it("a second click on an already-resolved item is a no-op", async () => {
    const { ctx, apiCalls } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, { ...verdictState(), resolvedVerdicts: { api: "approve" } });

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|vd|0|a"));

    expect(apiCalls).toHaveLength(0);
    expect(callbackAnswers[0]).toContain("Already resolved");
  });
});

describe("ask_user_questions callbacks", () => {
  const questionsState = () =>
    baseState({
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
            prompt: "Anything else?",
            selectionMode: "single",
            required: false,
            options: [],
          },
        ],
      },
    });

  it("walks the questions one at a time and submits a single respond call at the end", async () => {
    const { ctx, apiCalls, stateStore } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, questionsState());

    // Q1: pick "prod" → advances to Q2, no API call yet
    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|qo|1"));
    expect(apiCalls).toHaveLength(0);
    expect(editedMessages[0]?.text).toContain("Question 2/2");

    // Q2: skip (optional) → submits all answers in one respond call
    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|qs"));
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]?.url).toContain("/interactions/int-1/respond");
    expect(apiCalls[0]?.body).toEqual({
      answers: [
        { questionId: "q1", optionIds: ["prod"] },
        { questionId: "q2", optionIds: [] },
      ],
    });
    expect(editedMessages.at(-1)?.text).toContain("Answers submitted");
    expect(stateStore.get("instance||ixflow_tok1234567")).toBeNull();
  });

  it("free text goes through ForceReply and lands in otherText", async () => {
    const { ctx, apiCalls, stateStore } = makeCtx();
    const { handleInteractionCallback, handleInteractionPromptReply } =
      await import("../src/interaction-callbacks.js");
    const state = questionsState();
    (state.payload as { questions: Array<{ allowOther?: boolean }> }).questions[0]!.allowOther = true;
    await seedState(ctx, state);

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|qt"));
    expect(sentMessages[0]?.options?.forceReply).toBe(true);

    const { messageId, mapping } = findPromptMapping(stateStore);
    await handleInteractionPromptReply(
      makeDeps(ctx),
      mapping as Parameters<typeof handleInteractionPromptReply>[1],
      messageId,
      { message_id: 501, chat: { id: 42 }, text: "Staging, actually.", from: { id: 7, username: "greg" } },
    );

    // advanced to Q2 with the free-text answer recorded, not yet submitted
    expect(apiCalls).toHaveLength(0);
    const saved = stateStore.get("instance||ixflow_tok1234567") as InteractionFlowState;
    expect(saved.answers).toEqual([{ questionId: "q1", optionIds: [], otherText: "Staging, actually." }]);
    expect(saved.questionIndex).toBe(1);
  });

  it("a required question cannot be skipped", async () => {
    const { ctx } = makeCtx();
    const { handleInteractionCallback } = await import("../src/interaction-callbacks.js");
    await seedState(ctx, questionsState());

    await handleInteractionCallback(makeDeps(ctx), query("ix|tok1234567|qs"));

    expect(callbackAnswers[0]).toContain("required");
  });
});
