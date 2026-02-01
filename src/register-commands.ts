import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const token = mustGetEnv("DISCORD_TOKEN");
const clientId = mustGetEnv("DISCORD_CLIENT_ID");
const guildId = process.env.DISCORD_GUILD_ID; // optional

const command = new SlashCommandBuilder()
  .setName("atv-ai")
  .setDescription("Talk to ATV-AI (chat + event creation).")
  .addStringOption((opt) =>
    opt.setName("text").setDescription("What you want to say to the bot").setRequired(true)
  );

async function main() {
  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: [command.toJSON()],
    });
    console.log("Registered /atv-ai (guild)");
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), {
    body: [command.toJSON()],
  });
  console.log("Registered /atv-ai (global)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
