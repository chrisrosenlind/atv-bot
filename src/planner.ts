// src/planner.ts
import { openai } from "./openai.js";
import { CONFIG } from "./config.js";
import type { Session } from "./sessions.js";
import type { EventDraft } from "./discord-events.js";

export type PlannerResult =
  | {
      action: "chat";
      reply: string;
      sessionPatch?: Partial<Session>;
    }
  | {
      action: "ask";
      question: string;
      sessionPatch: Partial<Session>;
    }
  | {
      action: "propose_event";
      draft: EventDraft;
      sessionPatch: Partial<Session>;
    };

export type PlannerContext = {
  timezone: string;
  nowIso: string;
  voiceChannels: { id: string; name: string; kind: "VOICE" | "STAGE" }[];
};

/**
 * NOTE on Structured Outputs strict JSON Schema:
 * - For every object schema, `required` must be present and include *all* property keys.
 * - To represent "optional", we allow `null` and then omit fields server-side.
 */
function plannerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["chat", "ask", "propose_event"] },

      // action="chat"
      reply: { type: ["string", "null"] },

      // action="ask"
      question: { type: ["string", "null"] },

      // action="propose_event"
      draft: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: ["string", "null"] },

          scheduledStartTime: { type: "string", description: "ISO 8601 timestamp" },
          scheduledEndTime: { type: ["string", "null"], description: "ISO 8601 timestamp" },

          entityType: { type: "string", enum: ["EXTERNAL", "VOICE", "STAGE"] },

          location: { type: ["string", "null"] },
          channelId: { type: ["string", "null"] },
        },
        required: [
          "name",
          "description",
          "scheduledStartTime",
          "scheduledEndTime",
          "entityType",
          "location",
          "channelId",
        ],
      },

      sessionPatch: {
        type: "object",
        additionalProperties: false,
        properties: {
          // allow null = "no change"
          mode: { type: ["string", "null"], enum: ["chat", "event", null] },
          // allow null or "null" = set awaiting to null
          awaiting: {
            type: ["string", "null"],
            enum: ["name", "where", "duration", "description", "confirm", "null", null],
          },
        },
        required: ["mode", "awaiting"],
      },
    },
    required: ["action", "reply", "question", "draft", "sessionPatch"],
  };
}

export async function planNext(
  userText: string,
  session: Session | undefined,
  ctx: PlannerContext
): Promise<PlannerResult> {
  const devInstructions = [
    `You are a Discord bot assistant.`,
    `You can do two things: (1) normal chat Q&A, (2) create a Discord Scheduled Event.`,
    `If the user wants an event, collect missing fields by asking ONE question at a time.`,
    `Timezone is ${ctx.timezone}. Current time is ${ctx.nowIso}.`,
    `If date/time is ambiguous, ask a clarification.`,
    `When ready, output action="propose_event" with a complete draft.`,
    `If user is just chatting, output action="chat".`,
    ``,
    `Event rules:`,
    `- entityType must be VOICE, STAGE, or EXTERNAL.`,
    `- If VOICE or STAGE, you must provide channelId. Available channels:`,
    ...ctx.voiceChannels.map((c) => `  - ${c.kind}: "${c.name}" id=${c.id}`),
    `- If EXTERNAL, you must provide location.`,
    `- Always output ISO 8601 timestamps.`,
    `- Ask for event name if missing.`,
    `- If end time is missing, ask duration OR assume ${CONFIG.defaultDurationMinutes} minutes if the user seems fine with defaults.`,
    ``,
    `Output format: JSON that matches the provided schema.`,
    `- Use null for fields you are not providing / no change.`,
    `- For sessionPatch.mode: "chat"|"event"|null`,
    `- For sessionPatch.awaiting: "name"|"where"|"duration"|"description"|"confirm"|"null"|null`,
  ].join("\n");

  const input = [
    { role: "developer" as const, content: devInstructions },
    ...(session
      ? [
          {
            role: "developer" as const,
            content: `Existing session: mode=${session.mode}, awaiting=${session.awaiting ?? "null"}, currentDraft=${JSON.stringify(
              session.eventDraft ?? {}
            )}`,
          },
        ]
      : []),
    { role: "user" as const, content: userText },
  ];

  const response = await openai.responses.create({
    model: CONFIG.openaiModel,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "planner",
        strict: true,
        schema: plannerSchema(),
      },
    },
    temperature: 0.3,
  });

  const raw = response.output_text?.trim();
  if (!raw) return { action: "chat", reply: "I didn’t get a usable response. Try again." };

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { action: "chat", reply: raw };
  }

  const patch = normalizeSessionPatch(parsed.sessionPatch);

  if (parsed?.action === "chat") {
    const reply = String(parsed.reply ?? "").trim();
    return {
      action: "chat",
      reply: reply || "OK.",
      ...(Object.keys(patch).length ? { sessionPatch: patch } : {}),
    };
  }

  if (parsed?.action === "ask") {
    const question = String(parsed.question ?? "").trim();
    if (!question) {
      return { action: "chat", reply: "I need one detail to proceed—what should I clarify?" };
    }
    return { action: "ask", question, sessionPatch: patch };
  }

  if (parsed?.action === "propose_event") {
    const d = parsed.draft ?? {};

    // Convert nulls -> omit properties to satisfy exactOptionalPropertyTypes downstream
    const draft: EventDraft = {
      name: String(d.name ?? "").trim(),
      scheduledStartTime: String(d.scheduledStartTime ?? "").trim(),
      entityType: d.entityType,
      ...(d.description ? { description: String(d.description) } : {}),
      ...(d.scheduledEndTime ? { scheduledEndTime: String(d.scheduledEndTime) } : {}),
      ...(d.location ? { location: String(d.location) } : {}),
      ...(d.channelId ? { channelId: String(d.channelId) } : {}),
    };

    return { action: "propose_event", draft, sessionPatch: patch };
  }

  return { action: "chat", reply: "I’m not sure what you want. Can you rephrase?" };
}

function normalizeSessionPatch(patch: any): Partial<Session> {
  const rawMode = patch?.mode;
  const mode =
    rawMode === "event" ? "event" : rawMode === "chat" ? "chat" : undefined;

  const awaitingRaw = patch?.awaiting;
  const awaiting =
    awaitingRaw === null || awaitingRaw === "null"
      ? null
      : (["name", "where", "duration", "description", "confirm"] as const).includes(awaitingRaw)
      ? awaitingRaw
      : undefined;

  const out: Partial<Session> = {};
  if (mode !== undefined) out.mode = mode;
  if (awaiting !== undefined) out.awaiting = awaiting;
  return out;
}
