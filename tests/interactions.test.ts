import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { IssueThreadInteraction } from "@paperclipai/shared";

// Coverage for pending interaction cards (decision cards): discovery on the
// in_review transition, the periodic sweep, durable dedupe, and the inbound
// guard that keeps a plain-text reply from becoming a comment while a card
// is pending.

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = await vi.importActual("@paperclipai/plugin-sdk") as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  let nextMessageId = 100;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return nextMessageId++;
    }),
    setMyCommands: vi.fn().mockResolvedValue(true),
  };
});

function pendingInteraction(overrides: Partial<IssueThreadInteraction> = {}): IssueThreadInteraction {
  return {
    id: "int-1",
    companyId: "company-a",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    summary: "Please review revision 3.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "requested",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdByAgentId: "agent-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    payload: { version: 1, prompt: "Approve?" },
    ...overrides,
  } as unknown as IssueThreadInteraction;
}

/** Stateful ctx: `state` is a real map so durable dedupe is observable. */
function makeCtx(opts: {
  interactions?: IssueThreadInteraction[];
  listInteractionsError?: boolean;
  issue?: { id: string; identifier?: string; title?: string };
} = {}) {
  const stateStore = new Map<string, unknown>();
  const stateKey = (scope: { scopeKind: string; scopeId?: string; stateKey: string }) =>
    `${scope.scopeKind}|${scope.scopeId ?? ""}|${scope.stateKey}`;

  const ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { on: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    actions: { register: vi.fn() },
    data: { register: vi.fn() },
    state: {
      get: vi.fn(async (scope: Parameters<typeof stateKey>[0]) => stateStore.get(stateKey(scope)) ?? null),
      set: vi.fn(async (scope: Parameters<typeof stateKey>[0], value: unknown) => {
        stateStore.set(stateKey(scope), value);
      }),
    },
    companies: {
      list: vi.fn().mockResolvedValue([{ id: "company-a", issuePrefix: "ACM" }]),
      get: vi.fn().mockResolvedValue({ id: "company-a", issuePrefix: "ACM" }),
    },
    config: { get: vi.fn().mockRejectedValue(new Error("company context is required")) },
    secrets: { resolve: vi.fn().mockResolvedValue("bot-token") },
    http: { fetch: vi.fn().mockRejectedValue(new Error("network unavailable in tests")) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    agents: {
      get: vi.fn().mockResolvedValue({ id: "agent-1", name: "CTO" }),
      list: vi.fn().mockResolvedValue([]),
    },
    issues: {
      get: vi.fn().mockResolvedValue(
        opts.issue ?? { id: "issue-1", identifier: "ACM-7", title: "Ship the feature" },
      ),
      list: vi.fn().mockResolvedValue([]),
      listComments: vi.fn().mockResolvedValue([]),
      createComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
      listInteractions: opts.listInteractionsError
        ? vi.fn().mockRejectedValue(new Error("capability issue.interactions.read denied"))
        : vi.fn().mockResolvedValue(opts.interactions ?? []),
    },
  } as unknown as PluginContext;

  return { ctx, stateStore };
}

beforeEach(() => {
  sentMessages = [];
  vi.resetModules();
});

describe("interactions module", () => {
  it("formatPendingInteraction renders title, kind, requester, and a card deep link", async () => {
    const { formatPendingInteraction } = await import("../src/interactions.js");
    const msg = formatPendingInteraction(
      pendingInteraction(),
      { id: "issue-1", identifier: "ACM-7", title: "Ship the feature" },
      "CTO",
      { baseUrl: "https://paperclip.example", issuePrefix: "ACM" },
    );

    expect(msg.text).toContain("Decision Needed");
    expect(msg.text).toContain("ACM\\-7");
    expect(msg.text).toContain("Approve the plan");
    expect(msg.text).toContain("Confirmation");
    expect(msg.text).toContain("CTO");
    expect(msg.text).toContain("https://paperclip.example/ACM/issues/ACM-7#interaction-int-1");
    expect(msg.options.inlineKeyboard?.[0]?.[0]?.url).toBe(
      "https://paperclip.example/ACM/issues/ACM-7#interaction-int-1",
    );
  });

  it("formatPendingInteraction degrades without a public base URL", async () => {
    const { formatPendingInteraction } = await import("../src/interactions.js");
    const msg = formatPendingInteraction(
      pendingInteraction(),
      { id: "issue-1", identifier: null, title: "Ship the feature" },
      null,
    );
    expect(msg.text).toContain("Respond on the card in the web app");
    expect(msg.options.inlineKeyboard).toBeUndefined();
  });

  it("getPendingInteractions filters out resolved cards", async () => {
    const { getPendingInteractions } = await import("../src/interactions.js");
    const { ctx } = makeCtx({
      interactions: [
        pendingInteraction(),
        pendingInteraction({ id: "int-2", status: "accepted" } as Partial<IssueThreadInteraction>),
      ],
    });
    const pending = await getPendingInteractions(ctx, "issue-1", "company-a");
    expect(pending.map((p) => p.id)).toEqual(["int-1"]);
  });

  it("getPendingInteractions returns [] when the host denies the capability", async () => {
    const { getPendingInteractions } = await import("../src/interactions.js");
    const { ctx } = makeCtx({ listInteractionsError: true });
    const pending = await getPendingInteractions(ctx, "issue-1", "company-a");
    expect(pending).toEqual([]);
  });

  it("notifyPendingInteractions notifies once per interaction (durable dedupe)", async () => {
    const { notifyPendingInteractions } = await import("../src/interactions.js");
    const { ctx } = makeCtx({ interactions: [pendingInteraction()] });
    const issue = { id: "issue-1", identifier: "ACM-7", title: "Ship the feature" };

    const first = await notifyPendingInteractions(ctx, "token", issue, "company-a", "chat-1");
    const second = await notifyPendingInteractions(ctx, "token", issue, "company-a", "chat-1");

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.chatId).toBe("chat-1");
  });

  it("notifyPendingInteractions maps the sent message to the issue for the inbound guard", async () => {
    const { notifyPendingInteractions } = await import("../src/interactions.js");
    const { ctx, stateStore } = makeCtx({ interactions: [pendingInteraction()] });
    const issue = { id: "issue-1", identifier: "ACM-7", title: "Ship the feature" };

    await notifyPendingInteractions(ctx, "token", issue, "company-a", "chat-1");

    const mappingKey = [...stateStore.keys()].find((k) => k.startsWith("instance||msg_chat-1_"));
    expect(mappingKey).toBeDefined();
    const mapping = stateStore.get(mappingKey!) as Record<string, unknown>;
    expect(mapping).toMatchObject({
      entityId: "issue-1",
      entityType: "issue",
      companyId: "company-a",
      interactionId: "int-1",
    });
  });
});

describe("issue.updated → in_review detection", () => {
  async function bootstrapWorker(ctxBundle: ReturnType<typeof makeCtx>) {
    const { plugin } = await import("../src/worker.js");
    const registered: Record<string, Array<(event: unknown) => unknown>> = {};
    (ctxBundle.ctx.events.on as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string, fn: (event: unknown) => unknown) => {
        (registered[name] ??= []).push(fn);
      },
    );
    // Attribution probes scoped config: answer for company-a only.
    const companyConfig = { telegramBotTokenRef: "ref-a", defaultChatId: "chat-1" };
    (ctxBundle.ctx.config.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (companyId?: string) => {
        if (companyId === "company-a") return companyConfig;
        throw new Error("company context is required");
      },
    );
    await plugin.definition.setup(ctxBundle.ctx);
    await plugin.definition.onConfigChanged!(companyConfig);
    return { registered };
  }

  async function emitInReview(registered: Record<string, Array<(event: unknown) => unknown>>) {
    for (const handler of registered["issue.updated"] ?? []) {
      await handler({
        eventType: "issue.updated",
        companyId: "company-a",
        entityType: "issue",
        entityId: "issue-1",
        payload: { status: "in_review" },
      });
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies pending cards when an issue moves to in_review", async () => {
    const bundle = makeCtx({ interactions: [pendingInteraction()] });
    const { registered } = await bootstrapWorker(bundle);

    await emitInReview(registered);

    const cardMessages = sentMessages.filter((m) => m.text.includes("Decision Needed"));
    expect(cardMessages).toHaveLength(1);
    expect(bundle.ctx.issues.listInteractions).toHaveBeenCalledWith("issue-1", "company-a");
  });

  it("sends nothing when the issue has no pending card", async () => {
    const bundle = makeCtx({ interactions: [] });
    const { registered } = await bootstrapWorker(bundle);

    await emitInReview(registered);

    expect(sentMessages.filter((m) => m.text.includes("Decision Needed"))).toHaveLength(0);
  });

  it("ignores non-in_review status updates", async () => {
    const bundle = makeCtx({ interactions: [pendingInteraction()] });
    const { registered } = await bootstrapWorker(bundle);

    for (const handler of registered["issue.updated"] ?? []) {
      await handler({
        eventType: "issue.updated",
        companyId: "company-a",
        entityType: "issue",
        entityId: "issue-1",
        payload: { status: "in_progress" },
      });
    }

    expect(sentMessages.filter((m) => m.text.includes("Decision Needed"))).toHaveLength(0);
  });
});

describe("inbound guard", () => {
  const config = {
    enableCommands: false,
    enableInbound: true,
  } as Parameters<typeof import("../src/worker.js").handleUpdate>[2];

  function replyUpdate() {
    return {
      update_id: 1,
      message: {
        message_id: 55,
        from: { id: 42, username: "greg" },
        chat: { id: 777, type: "private" },
        text: "ok go ahead",
        reply_to_message: { message_id: 9, from: { is_bot: true } },
      },
    } as Parameters<typeof import("../src/worker.js").handleUpdate>[3];
  }

  async function seedIssueMapping(stateStore: Map<string, unknown>) {
    stateStore.set("instance||msg_777_9", {
      entityId: "issue-1",
      entityType: "issue",
      companyId: "company-a",
      eventType: "interaction.pending",
    });
  }

  it("blocks the comment and replies with the card link while a card is pending", async () => {
    const { handleUpdate } = await import("../src/worker.js");
    const bundle = makeCtx({ interactions: [pendingInteraction()] });
    await seedIssueMapping(bundle.stateStore);

    await handleUpdate(
      bundle.ctx,
      "token",
      config,
      replyUpdate(),
      "http://localhost:3100",
      "https://paperclip.example",
    );

    expect(bundle.ctx.issues.createComment).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toContain("Not posted as a comment");
    expect(sentMessages[0]!.text).toContain("#interaction-int-1");
    expect(sentMessages[0]!.options).toMatchObject({ replyToMessageId: 55 });
  });

  it("still creates a comment when no card is pending", async () => {
    const { handleUpdate } = await import("../src/worker.js");
    const bundle = makeCtx({ interactions: [] });
    await seedIssueMapping(bundle.stateStore);

    await handleUpdate(bundle.ctx, "token", config, replyUpdate(), "http://localhost:3100");

    expect(bundle.ctx.issues.createComment).toHaveBeenCalledWith("issue-1", "ok go ahead", "company-a");
    expect(sentMessages).toHaveLength(0);
  });

  it("falls back to commenting when the host denies the interactions capability", async () => {
    const { handleUpdate } = await import("../src/worker.js");
    const bundle = makeCtx({ listInteractionsError: true });
    await seedIssueMapping(bundle.stateStore);

    await handleUpdate(bundle.ctx, "token", config, replyUpdate(), "http://localhost:3100");

    expect(bundle.ctx.issues.createComment).toHaveBeenCalledWith("issue-1", "ok go ahead", "company-a");
  });
});
