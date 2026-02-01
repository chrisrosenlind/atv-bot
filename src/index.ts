import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
} from "discord.js";
import type { Interaction } from "discord.js";
import { CONFIG } from "./config.js";
import { makeSessionKey, getSession, upsertSession, clearSession } from "./sessions.js";
import { planNext } from "./planner.js";
import {
  createDiscordScheduledEvent,
  listSchedulableChannels,
  renderEventPreview,
  type EventDraft,
} from "./discord-events.js";
import { DateTime } from "luxon";


const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("Missing DISCORD_TOKEN");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,

    // Required so the bot can see your normal follow-up messages:
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const CONFIRM_ID = "atv_ai_confirm";
const CANCEL_ID = "atv_ai_cancel";

function confirmRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CONFIRM_ID).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CANCEL_ID).setLabel("Cancel").setStyle(ButtonStyle.Danger)
  );
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    // Slash command entry point
    if (interaction.isChatInputCommand() && interaction.commandName === "atv-ai") {
      const text = interaction.options.getString("text", true);

      if (!interaction.guildId || !interaction.channelId) {
        await interaction.reply({ content: "This command only works in a server channel.", });
        return;
      }
      const key = makeSessionKey(interaction.guildId, interaction.channelId, interaction.user.id);

      // Start/refresh a session on slash invocation
      const existing = getSession(key);
      const session = upsertSession(key, existing ? {} : { mode: "chat", awaiting: null });

      await interaction.deferReply();

      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply("Guild not available.");
        return;
      }

      const ctx = {
        timezone: CONFIG.timezone,
        nowIso: DateTime.now().setZone(CONFIG.timezone).toISO() ?? new Date().toISOString(),
        voiceChannels: listSchedulableChannels(guild),
      };

      const planned = await planNext(text, session, ctx);
      const nextSession = upsertSession(key, planned.sessionPatch ?? {});
      // If the user asked “create event …”, strongly bias session to event mode
      if (planned.action !== "chat" && nextSession.mode !== "event") upsertSession(key, { mode: "event" });

      if (planned.action === "chat") {
        // Keep session open so the user can keep talking normally after /atv-ai
        await interaction.editReply(planned.reply);
        return;
      }

      if (planned.action === "ask") {
        await interaction.editReply(planned.question);
        return;
      }

      // propose_event => show preview + buttons
      const draft = planned.draft;
      upsertSession(key, { mode: "event", awaiting: "confirm", eventDraft: draft });

      await interaction.editReply({
        content: renderEventPreview(draft),
        components: [confirmRow()],
      });
      return;
    }

    // Confirm/cancel buttons
    if (interaction.isButton() && interaction.guildId && interaction.channelId) {
      const userId = interaction.user.id;
      const key = makeSessionKey(interaction.guildId, interaction.channelId, userId);
      const session = getSession(key);

      if (!session?.eventDraft) {
        await interaction.reply({ content: "No active event draft found.",});
        return;
      }

      if (interaction.customId === CANCEL_ID) {
        clearSession(key);
        await interaction.reply({ content: "Cancelled. Session cleared.",});
        return;
      }

      if (interaction.customId === CONFIRM_ID) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral});

        const guild = interaction.guild;
        if (!guild) {
          await interaction.editReply("Guild not available.");
          return;
        }

        const draft = session.eventDraft as EventDraft;

        const created = await createDiscordScheduledEvent(guild, draft);
        clearSession(key);

        await interaction.editReply(`Created scheduled event: **${created.name}**`);
        return;
      }
    }
  } catch (e: any) {
    console.error(e);
    if (interaction.isRepliable()) {
      const msg = e?.message ? String(e.message) : "Unknown error.";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(`Error: ${msg}`);
        } else {
          await interaction.reply({ content: `Error: ${msg}`, });
        }
      } catch {
        // ignore
      }
    }
  }
});

// Normal messages: continue session without more slash commands
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guildId || !message.channelId) return;

    const key = makeSessionKey(message.guildId, message.channelId, message.author.id);
    const session = getSession(key);
    if (!session) return; // IMPORTANT: bot only responds if user started via /atv-ai recently

    const guild = message.guild;
    if (!guild) return;

    const ctx = {
      timezone: CONFIG.timezone,
      nowIso: DateTime.now().setZone(CONFIG.timezone).toISO() ?? new Date().toISOString(),
      voiceChannels: listSchedulableChannels(guild),
    };

    const planned = await planNext(message.content, session, ctx);

    // Merge session patch
    upsertSession(key, planned.sessionPatch ?? {});

    if (planned.action === "chat") {
      await message.reply(planned.reply);
      return;
    }

    if (planned.action === "ask") {
      // Ensure event mode when we’re asking event questions
      upsertSession(key, { mode: "event" });
      await message.reply(planned.question);
      return;
    }

    // propose_event => show preview + buttons
    upsertSession(key, { mode: "event", awaiting: "confirm", eventDraft: planned.draft });

    await message.reply({
      content: renderEventPreview(planned.draft),
      components: [confirmRow()],
    });
  } catch (e) {
    console.error(e);
    // Avoid noisy errors in chat; optionally reply with a generic message.
  }
});

client.login(token);
