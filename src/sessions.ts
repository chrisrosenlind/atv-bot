import type { EventDraft } from "./discord-events.js";
import { CONFIG } from "./config.js";

export type SessionMode = "chat" | "event";

export type Session = {
  key: string;
  mode: SessionMode;
  eventDraft?: Partial<EventDraft> | undefined;
  awaiting?:
    | "name"
    | "where"
    | "duration"
    | "description"
    | "confirm"
    | null
    | undefined;
  expiresAtMs: number;
};


const sessions = new Map<string, Session>();

export function makeSessionKey(guildId: string, channelId: string, userId: string) {
  return `${guildId}:${channelId}:${userId}`;
}

export function getSession(key: string): Session | undefined {
  const s = sessions.get(key);
  if (!s) return undefined;
  if (Date.now() > s.expiresAtMs) {
    sessions.delete(key);
    return undefined;
  }
  return s;
}

export function upsertSession(key: string, patch: Partial<Session>): Session {
  const current = getSession(key);
  const ttlMs = CONFIG.sessionTtlMinutes * 60_000;

  const next: Session = {
    key,
    mode: current?.mode ?? "chat",
    awaiting: current?.awaiting ?? null,
    eventDraft: current?.eventDraft,
    ...current,
    ...patch,
    expiresAtMs: Date.now() + ttlMs,
  };

  sessions.set(key, next);
  return next;
}


export function clearSession(key: string) {
  sessions.delete(key);
}
