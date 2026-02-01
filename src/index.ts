import { Client, Events, GatewayIntentBits } from 'discord.js';

import dotenv from 'dotenv';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

console.log('ATV-bot running...');
