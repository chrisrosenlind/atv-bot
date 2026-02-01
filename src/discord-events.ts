import {
  ChannelType,
  Guild,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from "discord.js";
import { DateTime } from "luxon";
import { CONFIG } from "./config.js";

export type EventDraft = {
  name: string;
  description?: string;
  scheduledStartTime: string; // ISO8601
  scheduledEndTime?: string;  // ISO8601
  entityType: "EXTERNAL" | "VOICE" | "STAGE";
  location?: string;          // required if EXTERNAL
  channelId?: string;         // required if VOICE/STAGE
};

export function listSchedulableChannels(guild: Guild) {
  const voiceLike: { id: string; name: string; kind: "VOICE" | "STAGE" }[] = [];

  for (const [, ch] of guild.channels.cache) {
    if (ch.type === ChannelType.GuildVoice) {
      voiceLike.push({ id: ch.id, name: ch.name, kind: "VOICE" });
    }
    if (ch.type === ChannelType.GuildStageVoice) {
      voiceLike.push({ id: ch.id, name: ch.name, kind: "STAGE" });
    }
  }
  return voiceLike;
}

export function validateDraft(draft: EventDraft): string | null {
  if (!draft.name?.trim()) return "Missing event name.";
  if (!draft.scheduledStartTime) return "Missing start time.";
  if (!draft.entityType) return "Missing entity type.";

  const start = DateTime.fromISO(draft.scheduledStartTime, { zone: CONFIG.timezone });
  if (!start.isValid) return "Start time is not a valid ISO timestamp.";
  if (start.toMillis() < Date.now() + 60_000) return "Start time must be in the future.";

  if (draft.scheduledEndTime) {
    const end = DateTime.fromISO(draft.scheduledEndTime, { zone: CONFIG.timezone });
    if (!end.isValid) return "End time is not a valid ISO timestamp.";
    if (end <= start) return "End time must be after start time.";
  }

  if (draft.entityType === "EXTERNAL") {
    if (!draft.location?.trim()) return "External events require a location.";
  } else {
    if (!draft.channelId?.trim()) return "Voice/Stage events require a channelId.";
  }

  return null;
}

export function applyDefaultEndTimeIfMissing(draft: EventDraft): EventDraft {
  if (draft.scheduledEndTime) return draft;

  const start = DateTime.fromISO(draft.scheduledStartTime, { zone: CONFIG.timezone });
  const endIso = start.plus({ minutes: CONFIG.defaultDurationMinutes }).toISO();

  // If Luxon couldn't produce an ISO string, don't add the field
  if (!endIso) return draft;

  return { ...draft, scheduledEndTime: endIso };
}


export function renderEventPreview(draft: EventDraft): string {
  const start = DateTime.fromISO(draft.scheduledStartTime, { zone: CONFIG.timezone });
  const end = draft.scheduledEndTime
    ? DateTime.fromISO(draft.scheduledEndTime, { zone: CONFIG.timezone })
    : null;

  const when = end?.isValid
    ? `${start.toFormat("dd LLL yyyy HH:mm")}–${end.toFormat("HH:mm")} (${CONFIG.timezone})`
    : `${start.toFormat("dd LLL yyyy HH:mm")} (${CONFIG.timezone})`;

  const where =
    draft.entityType === "EXTERNAL"
      ? `External: ${draft.location ?? "(missing location)"}`
      : `${draft.entityType}: <#${draft.channelId ?? "missing"}>`;

  return [
    `**Event preview**`,
    `**Name:** ${draft.name}`,
    draft.description ? `**Description:** ${draft.description}` : null,
    `**When:** ${when}`,
    `**Where:** ${where}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function createDiscordScheduledEvent(guild: Guild, draft: EventDraft) {
  const finalDraft = applyDefaultEndTimeIfMissing(draft);
  const err = validateDraft(finalDraft);
  if (err) throw new Error(err);

  const entityType =
    finalDraft.entityType === "EXTERNAL"
      ? GuildScheduledEventEntityType.External
      : finalDraft.entityType === "STAGE"
      ? GuildScheduledEventEntityType.StageInstance
      : GuildScheduledEventEntityType.Voice;

  const options = {
    name: finalDraft.name,
    ...(finalDraft.description ? { description: finalDraft.description } : {}),
    scheduledStartTime: new Date(finalDraft.scheduledStartTime),
    ...(finalDraft.scheduledEndTime
      ? { scheduledEndTime: new Date(finalDraft.scheduledEndTime) }
      : {}),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType,
    ...(finalDraft.entityType === "EXTERNAL"
      ? { entityMetadata: { location: finalDraft.location! as string } }
      : { channel: finalDraft.channelId! }),
  } satisfies Parameters<typeof guild.scheduledEvents.create>[0];

  return guild.scheduledEvents.create(options);
}

