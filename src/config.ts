export const CONFIG = {
  timezone: process.env.BOT_TIMEZONE ?? "Europe/Stockholm",
  sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES ?? "10"),
  defaultDurationMinutes: Number(process.env.DEFAULT_EVENT_DURATION_MINUTES ?? "60"),
  openaiModel: "gpt-4o-mini" // compatible with structured outputs per docs :contentReference[oaicite:2]{index=2}
};
