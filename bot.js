require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, EmbedBuilder, SlashCommandBuilder,
} = require('discord.js');

// ---------- Settings (can be overridden in .env) ----------
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';
const COMMUNITY_ROLE_NAME = process.env.COMMUNITY_ROLE_NAME || 'Community';
const STAFF_ROLE_NAME = process.env.STAFF_ROLE_NAME || '.';
const TEAMS_CHANNEL_NAME = (process.env.TEAMS_CHANNEL_NAME || 'teams').toLowerCase();
const SIGNUP_CHANNEL_NAME = (process.env.SIGNUP_CHANNEL_NAME || 'signup').toLowerCase();
const TICKET_CATEGORY_NAME = process.env.TICKET_CATEGORY_NAME || 'Bracket Signups';
const CLOSE_DELAY_MS = 30 * 1000;
const DM_CLOSED_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;
// Manage Roles, Manage Channels, View Channels, Send Messages, Manage Messages, Embed Links, Read Message History
const INVITE_PERMISSIONS = '268528656';

const MODES = ['1v1', '2v2', '3v3', '4v4'];
const TYPES = ['Zonewars', 'Realistics', 'Boxfights', 'Buildfights'];
const REGIONS = ['East', 'West', 'Central'];

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Open the .env file and paste your bot token after DISCORD_TOKEN=');
  process.exit(1);
}

// ---------- Saved data ----------
const DATA_FILE = path.join(__dirname, 'data.json');
let data;
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { data = null; }
if (!data || !data.guilds) data = { guilds: {}, closures: [] };
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function guildData(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = { tournament: null, teams: [], teamsChannelId: null, teamsMessageIds: [], signupPanel: null };
  }
  return data.guilds[guildId];
}

// Runs tasks for the same server one at a time so the teams list never gets double-posted.
const queues = new Map();
function queue(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- Helpers ----------
function isStaff(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.roles.cache.some(r => r.name === STAFF_ROLE_NAME);
}

function getStaffRole(guild) {
  return guild.roles.cache.find(r => r.name === STAFF_ROLE_NAME) || null;
}

function tournamentName(t) {
  return t ? `${t.mode} ${t.type} — ${t.region}` : 'Tournament';
}

function signupQuestion(t) {
  if (t?.mode === '1v1') return { label: 'Your username', placeholder: 'Type out your username' };
  if (t?.mode === '2v2') return { label: "Your username and your teammate's username", placeholder: 'Type out your username and your teammates username' };
  return { label: "Your username and your teammates' usernames", placeholder: 'Type out your username and all of your teammates usernames' };
}

function findTextChannel(guild, nameFragment) {
  const text = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
  return text.find(c => c.name.toLowerCase() === nameFragment)
    || text.find(c => c.name.toLowerCase().includes(nameFragment))
    || null;
}

async function getCommunityRole(guild) {
  let role = guild.roles.cache.find(r => r.name === COMMUNITY_ROLE_NAME);
  if (!role) role = await guild.roles.create({ name: COMMUNITY_ROLE_NAME, reason: 'Community role for all members' });
  return role;
}

async function giveCommunityToEveryone(guild) {
  try {
    const role = await getCommunityRole(guild);
    if (!role.editable) {
      console.warn(`[${guild.name}] Can't give "${role.name}" - drag the bot's role ABOVE it in Server Settings > Roles.`);
      return;
    }
    const members = await guild.members.fetch();
    let given = 0;
    for (const member of members.values()) {
      if (member.user.bot || member.roles.cache.has(role.id)) continue;
      try { await member.roles.add(role, 'Community role'); given++; } catch (e) {
        console.warn(`[${guild.name}] Couldn't give role to ${member.user.tag}: ${e.message}`);
      }
    }
    console.log(`[${guild.name}] Gave "${role.name}" to ${given} member(s).`);
  } catch (e) {
    console.error(`[${guild.name}] Community role setup failed: ${e.message}`);
  }
}

async function getTicketCategory(guild) {
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === TICKET_CATEGORY_NAME,
  );
  if (!category) {
    const staffRole = getStaffRole(guild);
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel] },
    ];
    if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel] });
    category = await guild.channels.create({
      name: TICKET_CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: overwrites,
    });
  }
  return category;
}

// ---------- Auto-closing channels (survives bot restarts) ----------
function runClosure(channelId) {
  client.channels.fetch(channelId)
    .then(ch => ch.delete('Signup handled'))
    .catch(() => {})
    .finally(() => {
      data.closures = data.closures.filter(c => c.channelId !== channelId);
      save();
    });
}

function scheduleClose(channelId, delayMs) {
  const closeAt = Date.now() + delayMs;
  data.closures = data.closures.filter(c => c.channelId !== channelId);
  data.closures.push({ channelId, closeAt });
  save();
  setTimeout(() => runClosure(channelId), delayMs);
}

// ---------- Teams list ----------
// Rebuilds the numbered accepted-teams list in the Teams channel (edits the existing message instead of spamming).
async function refreshTeamsList(guild, { repost = false } = {}) {
  const gd = guildData(guild.id);
  const channel = findTextChannel(guild, TEAMS_CHANNEL_NAME);
  if (!channel) {
    console.warn(`[${guild.name}] No teams channel found. Make a text channel with "${TEAMS_CHANNEL_NAME}" in its name.`);
    return false;
  }
  if (channel.id !== gd.teamsChannelId) {
    gd.teamsChannelId = channel.id;
    gd.teamsMessageIds = [];
  }
  if (repost) {
    for (const id of gd.teamsMessageIds) await channel.messages.delete(id).catch(() => {});
    gd.teamsMessageIds = [];
  }

  const chunks = [];
  let current = '';
  gd.teams.forEach((team, i) => {
    const piece = `**Team ${i + 1}** — <@${team.userId}>\n${team.text}\n\n`;
    if (current.length + piece.length > 3900) { chunks.push(current); current = ''; }
    current += piece;
  });
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push('*No teams have been accepted yet.*');

  const heading = `🏆 ${tournamentName(gd.tournament)} — Accepted Teams (${gd.teams.length})`;
  const embeds = chunks.map((text, i) => new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(i === 0 ? heading : `${heading} (continued)`)
    .setDescription(text.trim()));

  const newIds = [];
  for (let i = 0; i < embeds.length; i++) {
    const oldId = gd.teamsMessageIds[i];
    let msg = oldId ? await channel.messages.fetch(oldId).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [embeds[i]] });
    else msg = await channel.send({ embeds: [embeds[i]] });
    newIds.push(msg.id);
  }
  for (const id of gd.teamsMessageIds.slice(embeds.length)) await channel.messages.delete(id).catch(() => {});
  gd.teamsMessageIds = newIds;
  save();
  return true;
}

// ---------- Sign up panel ----------
function signupPanel(t) {
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🎮 ${tournamentName(t)} — Sign Ups`)
    .addFields(
      { name: 'Mode', value: t.mode, inline: true },
      { name: 'Type', value: t.type, inline: true },
      { name: 'Region', value: t.region, inline: true },
    )
    .setDescription(`Click **Sign Up** below and ${signupQuestion(t).placeholder.toLowerCase()}.\n\nAn admin will review it and you'll get a DM when you're accepted or denied.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('signup_open').setLabel('Sign Up').setEmoji('📝').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

// Posts the Sign Up button in the signup channel (removing the old one).
async function postSignupPanel(guild, fallbackChannel) {
  const gd = guildData(guild.id);
  if (gd.signupPanel) {
    const old = await guild.channels.fetch(gd.signupPanel.channelId).catch(() => null);
    if (old) await old.messages.delete(gd.signupPanel.messageId).catch(() => {});
  }
  const channel = findTextChannel(guild, SIGNUP_CHANNEL_NAME) || fallbackChannel;
  const msg = await channel.send(signupPanel(gd.tournament));
  gd.signupPanel = { channelId: channel.id, messageId: msg.id };
  save();
  return channel;
}

// Removes the Sign Up button and shows a "sign ups closed" notice in its place.
async function closeSignups(guild, fallbackChannel) {
  const gd = guildData(guild.id);
  gd.tournament = null;
  if (gd.signupPanel) {
    const old = await guild.channels.fetch(gd.signupPanel.channelId).catch(() => null);
    if (old) await old.messages.delete(gd.signupPanel.messageId).catch(() => {});
    gd.signupPanel = null;
  }
  const channel = findTextChannel(guild, SIGNUP_CHANNEL_NAME) || fallbackChannel;
  if (channel) {
    const msg = await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Sign ups are closed right now')
        .setDescription('There\'s no tournament open at the moment. Check back soon, the Sign Up button will show up here when the next one opens!')],
    });
    gd.signupPanel = { channelId: channel.id, messageId: msg.id };
  }
  save();
}

// ---------- Channel setup & health check ----------
const WRITE_PERMS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];
const REQUIRED_BOT_PERMS = ['ManageRoles', 'ManageChannels', 'ViewChannel', 'SendMessages', 'ManageMessages', 'EmbedLinks', 'ReadMessageHistory'];

// Only the staff role (and the bot) can type. Everyone else can read.
async function lockChannel(channel, staffRole) {
  const guild = channel.guild;
  const writeOff = Object.fromEntries(WRITE_PERMS.map(p => [p, false]));
  const writeOn = Object.fromEntries(WRITE_PERMS.map(p => [p, true]));
  const writeNeutral = Object.fromEntries(WRITE_PERMS.map(p => [p, null]));

  await channel.permissionOverwrites.edit(client.user.id, {
    ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true,
  });
  await channel.permissionOverwrites.edit(guild.roles.everyone, writeOff);
  for (const ow of channel.permissionOverwrites.cache.values()) {
    if ([guild.roles.everyone.id, client.user.id, staffRole?.id].includes(ow.id)) continue;
    if (WRITE_PERMS.some(p => ow.allow.has(p))) await channel.permissionOverwrites.edit(ow.id, writeNeutral);
  }
  if (staffRole) await channel.permissionOverwrites.edit(staffRole, writeOn);
}

function signupInfoMessage() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🏆 Fortnite Brackets — Sign Ups')
      .setDescription([
        'Welcome to the bracket sign ups! Here\'s how it works:',
        '',
        '**1.** When a tournament is open, a **Sign Up** button appears below this message.',
        '**2.** Click it and type your Fortnite username (plus your teammates\' usernames for 2v2, 3v3 and 4v4).',
        '**3.** Admins review every team. You\'ll get a **DM** when you\'re accepted or denied, so keep your DMs open!',
        '**4.** Accepted teams are listed in the teams channel.',
        '',
        '⚠️ Double-check your usernames. Wrong or fake usernames can get your team denied.',
        '',
        '*No Sign Up button below? Sign ups are closed right now. Check back soon!*',
      ].join('\n'))],
  };
}

async function setupChannels(guild) {
  const gd = guildData(guild.id);
  const staffRole = getStaffRole(guild);

  let signup = findTextChannel(guild, SIGNUP_CHANNEL_NAME);
  const teams = findTextChannel(guild, TEAMS_CHANNEL_NAME);
  if (!signup) {
    signup = await guild.channels.create({
      name: 'signups', type: ChannelType.GuildText, parent: teams?.parentId ?? null,
      topic: 'Sign up for Fortnite brackets here.',
    });
    console.log(`[${guild.name}] Created #${signup.name}`);
  }

  for (const ch of [signup, teams]) {
    if (!ch) continue;
    try { await lockChannel(ch, staffRole); } catch (e) {
      console.warn(`[${guild.name}] Couldn't lock #${ch.name}: ${e.message}`);
    }
  }

  // Welcome / how-it-works message at the top of the signup channel (posted once)
  const infoMsg = gd.signupInfo?.channelId === signup.id
    ? await signup.messages.fetch(gd.signupInfo.messageId).catch(() => null)
    : null;
  if (!infoMsg) {
    const msg = await signup.send(signupInfoMessage());
    gd.signupInfo = { channelId: signup.id, messageId: msg.id };
    save();
    // keep the button (or the "closed" notice) below the info
    if (gd.tournament) await postSignupPanel(guild, signup);
    else await closeSignups(guild, signup);
  } else if (!gd.tournament && !gd.signupPanel) {
    await closeSignups(guild, signup);
  }

  if (teams) await queue(guild.id, () => refreshTeamsList(guild));
}

async function healthCheck(guild) {
  const ok = (good, text) => `${good ? '✅' : '❌'} ${text}`;
  const me = guild.members.me;
  const staffRole = getStaffRole(guild);
  const community = guild.roles.cache.find(r => r.name === COMMUNITY_ROLE_NAME);
  const signup = findTextChannel(guild, SIGNUP_CHANNEL_NAME);
  const teams = findTextChannel(guild, TEAMS_CHANNEL_NAME);
  const missingPerms = REQUIRED_BOT_PERMS.filter(p => !me.permissions.has(p));
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const withoutCommunity = community ? members.filter(m => !m.user.bot && !m.roles.cache.has(community.id)).size : -1;
  const commands = await guild.commands.fetch().catch(() => null);

  const typingOk = ch => {
    if (!ch) return false;
    const everyoneCantType = !ch.permissionsFor(guild.roles.everyone).has('SendMessages');
    const staffCanType = !staffRole || ch.permissionsFor(staffRole).has('SendMessages');
    const othersCantType = guild.roles.cache
      .filter(r => r.id !== staffRole?.id && !r.managed && !r.permissions.has('Administrator'))
      .every(r => !ch.permissionsFor(r).has('SendMessages'));
    return everyoneCantType && staffCanType && othersCantType;
  };

  return [
    `**Bracket Bot check — ${guild.name}**`,
    ok(missingPerms.length === 0, missingPerms.length ? `Bot is missing permissions: ${missingPerms.join(', ')}` : 'Bot has all the permissions it needs'),
    ok(!!staffRole, staffRole ? `Staff role \`${STAFF_ROLE_NAME}\` found` : `No role named \`${STAFF_ROLE_NAME}\` found`),
    ok(!!community && community.editable, community?.editable ? `Community role can be given out` : 'Community role is above the bot\'s role'),
    ok(withoutCommunity === 0, withoutCommunity === 0 ? 'Every member has the Community role' : `${withoutCommunity} member(s) still missing Community`),
    ok(!!signup, signup ? `Signup channel: #${signup.name}` : 'No signup channel'),
    ok(!!teams, teams ? `Teams channel: #${teams.name}` : `No channel with "${TEAMS_CHANNEL_NAME}" in its name`),
    ok(typingOk(signup), `Only \`${STAFF_ROLE_NAME}\` can type in the signup channel`),
    ok(typingOk(teams), `Only \`${STAFF_ROLE_NAME}\` can type in the teams channel`),
    ok(!!commands?.some(c => c.name === 'tournament'), '/tournament command is registered'),
    ok(true, `Current tournament: ${guildData(guild.id).tournament ? tournamentName(guildData(guild.id).tournament) : 'none yet (create one with /tournament)'}`),
    '*(Members with Administrator permission can always type anywhere — Discord doesn\'t allow blocking that.)*',
  ].join('\n');
}

async function prepareGuild(guild) {
  await registerCommands(guild);
  await giveCommunityToEveryone(guild);
  try { await setupChannels(guild); } catch (e) {
    console.error(`[${guild.name}] Channel setup failed: ${e.message}`);
  }
  console.log(`\n${(await healthCheck(guild)).replace(/\*\*|\*|`/g, '')}\n`);
}

// ---------- Slash command ----------
const tournamentCommand = new SlashCommandBuilder()
  .setName('tournament')
  .setDescription('Create a new tournament (admins only). This clears the old teams list.')
  .addStringOption(o => o.setName('mode').setDescription('Team size').setRequired(true)
    .addChoices(...MODES.map(v => ({ name: v, value: v }))))
  .addStringOption(o => o.setName('type').setDescription('Game type').setRequired(true)
    .addChoices(...TYPES.map(v => ({ name: v, value: v }))))
  .addStringOption(o => o.setName('region').setDescription('Server region').setRequired(true)
    .addChoices(...REGIONS.map(v => ({ name: v, value: v }))));

async function registerCommands(guild) {
  try { await guild.commands.set([tournamentCommand.toJSON()]); } catch (e) {
    console.warn(`[${guild.name}] Couldn't register /tournament: ${e.message}`);
  }
}

// ---------- Events ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`\nInvite link:\nhttps://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${INVITE_PERMISSIONS}&scope=bot+applications.commands\n`);

  // Pick back up any channels that were waiting to close before a restart
  for (const c of data.closures) setTimeout(() => runClosure(c.channelId), Math.max(0, c.closeAt - Date.now()));

  if (client.guilds.cache.size === 0) console.log('The bot is not in any server yet. Use the invite link above.');
  for (const guild of client.guilds.cache.values()) await prepareGuild(guild);
});

client.on(Events.GuildCreate, guild => prepareGuild(guild));

client.on(Events.GuildMemberAdd, async member => {
  if (member.user.bot) return;
  try {
    const role = await getCommunityRole(member.guild);
    await member.roles.add(role, 'New member');
  } catch (e) {
    console.warn(`[${member.guild.name}] Couldn't give Community to ${member.user.tag}: ${e.message}`);
  }
});

// ---------- ! Commands ----------
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = cmd.toLowerCase();
  if (!['help', 'setup', 'reset', 'remove', 'teams', 'check'].includes(command)) return;

  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📖 Bracket Bot — Commands')
      .setDescription(`Every command except \`!help\` only works for the \`${STAFF_ROLE_NAME}\` role and admins.`)
      .addFields(
        {
          name: '/tournament',
          value: 'Opens sign ups for a new tournament. Type `/tournament`, then pick from the lists:\n'
            + `• **mode:** ${MODES.join(', ')}\n• **type:** ${TYPES.join(', ')}\n• **region:** ${REGIONS.join(', ')}\n`
            + 'Posts the Sign Up button in the signups channel and clears the old teams list.\n'
            + 'Example: `/tournament mode:2v2 type:Realistics region:Central`',
        },
        {
          name: '!reset',
          value: 'Ends the tournament: removes every team from the teams list, removes the Sign Up button and shows "Sign ups are closed". Use it when a tournament is over.\nExample: `!reset`',
        },
        {
          name: '!remove <team number>',
          value: 'Removes one team from the teams list. Teams below it move up a number.\nExample: `!remove 3` removes Team 3',
        },
        {
          name: '!teams',
          value: 'Reposts the teams list (use it if the list message got deleted).\nExample: `!teams`',
        },
        {
          name: '!setup',
          value: 'Reposts the Sign Up button for the current tournament (use it if the button got deleted).\nExample: `!setup`',
        },
        {
          name: '!check',
          value: 'Fixes the setup (channels, permissions, Community role) and shows a ✅/❌ checklist.\nExample: `!check`',
        },
        {
          name: '!help',
          value: 'Shows this message.',
        },
        {
          name: 'How sign ups work',
          value: '1. Player clicks **Sign Up** and types their username(s).\n'
            + `2. A private channel opens for the \`${STAFF_ROLE_NAME}\` role with **Accept** / **Deny** buttons.\n`
            + '3. The player gets a DM with the result, accepted teams are added to the teams list, and the channel closes after 30 seconds.\n'
            + '4. If the player\'s DMs are closed, they can read (not type in) the channel for 24 hours instead.',
        },
      );
    return message.reply({ embeds: [embed] });
  }

  if (!isStaff(message.member)) return message.reply('❌ Only admins can use this command.');
  const gd = guildData(message.guild.id);

  if (command === 'check') {
    await giveCommunityToEveryone(message.guild);
    await setupChannels(message.guild).catch(e => console.error(e));
    return message.reply(await healthCheck(message.guild));
  }

  if (command === 'setup') {
    if (!gd.tournament) return message.reply('⚠️ No tournament yet. Create one with `/tournament` first.');
    const channel = await postSignupPanel(message.guild, message.channel);
    if (channel.id !== message.channel.id) await message.reply(`✅ Sign Up button posted in <#${channel.id}>.`);
    else await message.delete().catch(() => {});
    return;
  }

  if (command === 'teams') {
    return queue(message.guild.id, async () => {
      const ok = await refreshTeamsList(message.guild, { repost: true });
      if (!ok) await message.reply(`⚠️ No teams channel found. Make a text channel with "${TEAMS_CHANNEL_NAME}" in its name.`);
    });
  }

  if (command === 'reset') {
    return queue(message.guild.id, async () => {
      const count = gd.teams.length;
      gd.teams = [];
      await closeSignups(message.guild, message.channel);
      await refreshTeamsList(message.guild, { repost: true });
      await message.reply(`🧹 Reset done – removed ${count} team(s) from the Teams list and closed sign ups. Use \`/tournament\` to open the next one.`);
    });
  }

  if (command === 'remove') {
    return queue(message.guild.id, async () => {
      const n = parseInt(args[0], 10);
      if (!gd.teams.length) return message.reply('There are no teams on the list.');
      if (!n || n < 1 || n > gd.teams.length) {
        return message.reply(`Usage: \`!remove <number>\` (1–${gd.teams.length})`);
      }
      const [removed] = gd.teams.splice(n - 1, 1);
      save();
      await refreshTeamsList(message.guild);
      await message.reply(`🗑️ Removed Team ${n} (<@${removed.userId}>). Teams below it moved up one number.`);
    });
  }
});

// ---------- Slash commands, buttons & form ----------
const handledTickets = new Set();

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.guild) return;
    const guild = interaction.guild;

    // Admin creates a tournament
    if (interaction.isChatInputCommand() && interaction.commandName === 'tournament') {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: '❌ Only admins can create tournaments.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const t = {
        id: Date.now().toString(36),
        mode: interaction.options.getString('mode'),
        type: interaction.options.getString('type'),
        region: interaction.options.getString('region'),
        createdBy: interaction.user.id,
        createdAt: new Date().toISOString(),
      };
      let signupChannel;
      await queue(guild.id, async () => {
        const gd = guildData(guild.id);
        gd.tournament = t;
        gd.teams = [];
        save();
        await refreshTeamsList(guild, { repost: true });
        signupChannel = await postSignupPanel(guild, interaction.channel);
      });
      return interaction.editReply(`✅ Created **${tournamentName(t)}**. The Sign Up button is in <#${signupChannel.id}> and the Teams list was cleared.`);
    }

    // Player clicks "Sign Up" -> show the one-question form
    if (interaction.isButton() && interaction.customId === 'signup_open') {
      const gd = guildData(guild.id);
      if (!gd.tournament) {
        return interaction.reply({ content: 'Sign ups are not open right now.', flags: MessageFlags.Ephemeral });
      }
      if (gd.teams.some(team => team.userId === interaction.user.id)) {
        return interaction.reply({ content: '✅ Your team is already accepted for this tournament.', flags: MessageFlags.Ephemeral });
      }
      const existing = guild.channels.cache.find(c => c.topic === `signup:${interaction.user.id}`);
      if (existing) {
        return interaction.reply({ content: '⏳ You already have a signup waiting for review. Please wait for an admin.', flags: MessageFlags.Ephemeral });
      }
      const q = signupQuestion(gd.tournament);
      const modal = new ModalBuilder().setCustomId('signup_modal').setTitle('Bracket Sign Up');
      const input = new TextInputBuilder()
        .setCustomId('signup_text')
        .setLabel(q.label)
        .setPlaceholder(q.placeholder)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Player submits the form -> private admin channel
    if (interaction.isModalSubmit() && interaction.customId === 'signup_modal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const gd = guildData(guild.id);
      if (!gd.tournament) return interaction.editReply('Sign ups are not open right now.');
      const user = interaction.user;
      const text = interaction.fields.getTextInputValue('signup_text').trim();
      const staffRole = getStaffRole(guild);
      const category = await getTicketCategory(guild);

      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory],
        },
      ];
      if (staffRole) {
        overwrites.push({
          id: staffRole.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        });
      }

      const safeName = user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80) || 'player';
      const channel = await guild.channels.create({
        name: `signup-${safeName}`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `signup:${user.id}`,
        permissionOverwrites: overwrites,
      });

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`📝 New Sign Up — ${tournamentName(gd.tournament)}`)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .addFields({ name: 'Submitted by', value: `<@${user.id}>` })
        .setDescription(text)
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`signup_accept:${user.id}:${gd.tournament.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`signup_deny:${user.id}:${gd.tournament.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      );
      await channel.send({
        content: staffRole ? `<@&${staffRole.id}>` : undefined,
        allowedMentions: { roles: staffRole ? [staffRole.id] : [] },
        embeds: [embed],
        components: [row],
      });

      return interaction.editReply('✅ Your signup was sent to the admins! You\'ll get a DM once they accept or deny it.');
    }

    // Admin clicks Accept / Deny
    if (interaction.isButton() && /^signup_(accept|deny):\d+:\w+$/.test(interaction.customId)) {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: '❌ Only admins can do this.', flags: MessageFlags.Ephemeral });
      }
      if (handledTickets.has(interaction.message.id)) {
        return interaction.reply({ content: 'This signup was already handled.', flags: MessageFlags.Ephemeral });
      }
      handledTickets.add(interaction.message.id);

      const [action, userId, tournamentId] = interaction.customId.replace('signup_', '').split(':');
      const accepted = action === 'accept';
      const channel = interaction.channel;
      const gd = guildData(guild.id);
      const sameTournament = gd.tournament?.id === tournamentId;
      const original = interaction.message.embeds[0];
      const text = original?.description || '(no details)';

      const updated = EmbedBuilder.from(original)
        .setColor(accepted ? 0x2ecc71 : 0xe74c3c)
        .setFooter({ text: `${accepted ? 'Accepted' : 'Denied'} by ${interaction.user.tag}` });
      const disabledRow = new ActionRowBuilder().addComponents(
        ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
        ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true),
      );
      await interaction.update({ embeds: [updated], components: [disabledRow] });

      let teamNumber = null;
      if (accepted && sameTournament) {
        await queue(guild.id, async () => {
          gd.teams.push({ userId, text, acceptedAt: new Date().toISOString() });
          teamNumber = gd.teams.length;
          save();
          await refreshTeamsList(guild);
        });
      }

      const name = tournamentName(gd.tournament);
      const resultText = accepted
        ? `Your team has been **accepted** into **${name}** in **${guild.name}**${teamNumber ? ` as **Team ${teamNumber}**` : ''}. Good luck!\n\n**Your signup:**\n${text}`
        : `Sorry, your signup for **${name}** in **${guild.name}** was **denied**.`;

      let dmWorked = true;
      try {
        const user = await client.users.fetch(userId);
        await user.send({
          embeds: [new EmbedBuilder()
            .setColor(accepted ? 0x2ecc71 : 0xe74c3c)
            .setTitle(accepted ? '✅ You\'ve been accepted!' : '❌ Signup denied')
            .setDescription(resultText)],
        });
      } catch {
        dmWorked = false;
      }

      const oldNote = accepted && !sameTournament
        ? '\n⚠️ This signup was for an older tournament, so it was NOT added to the current Teams list.'
        : '';

      if (dmWorked) {
        await channel.send(`${accepted ? '✅ **Accepted**' : '❌ **Denied**'} by <@${interaction.user.id}>.${oldNote}\nThis channel will close in 30 seconds.`);
        scheduleClose(channel.id, CLOSE_DELAY_MS);
        return;
      }

      // DMs closed: let the player read (never type in) this channel for 24 hours, then close it.
      let playerAdded = true;
      try {
        await channel.permissionOverwrites.create(userId, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
          AttachFiles: false,
          EmbedLinks: false,
          UseApplicationCommands: false,
          SendVoiceMessages: false,
          SendPolls: false,
        });
      } catch {
        playerAdded = false;
      }

      await channel.send({
        content: `${accepted ? '✅ **Accepted**' : '❌ **Denied**'} by <@${interaction.user.id}>.${oldNote}\n`
          + (playerAdded
            ? `⚠️ Couldn't DM the player, so they can now **view** this channel (they can't type in it).\n\n<@${userId}> ${resultText}\n\n`
            : '⚠️ Couldn\'t DM the player and couldn\'t add them here (they may have left the server).\n')
          + 'This channel will close in 24 hours.',
        allowedMentions: { users: playerAdded ? [userId] : [] },
      });
      scheduleClose(channel.id, DM_CLOSED_CLOSE_DELAY_MS);
    }
  } catch (e) {
    console.error('Interaction error:', e);
    const content = '⚠️ Something went wrong. Make sure the bot has the right permissions.';
    if (interaction.deferred) interaction.editReply(content).catch(() => {});
    else if (!interaction.replied && interaction.isRepliable()) interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);
