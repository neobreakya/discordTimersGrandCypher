require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
const http = require('http');
const db = require('./database');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Configuration
const UPDATE_INTERVAL = 90000; // Update every 90 seconds
const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;

// In-memory cache (loaded from database)
const guildChannels = new Map(); // guildId -> channelId
const guildEvents = new Map();   // guildId -> events[]
const eventMessages = new Map(); // "guildId:eventName" -> messageId

// Health check server for Render
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel for event timers')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to post timers in')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('settimezone')
    .setDescription('Set your timezone for automatic time conversion')
    .addIntegerOption(option =>
      option.setName('offset')
        .setDescription('UTC offset (e.g., +9 for JST, -6 for CST, -5 for EST, +0 for GMT)')
        .setRequired(true)
        .setMinValue(-12)
        .setMaxValue(14)),
  
  new SlashCommandBuilder()
    .setName('addevent')
    .setDescription('Add a new event timer')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Event name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('time')
        .setDescription('Start time in 24hr format (HH:MM, e.g., 14:30)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Event duration (DD:HH:MM or HH:MM, e.g., 01:02:15 or 02:30)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('days')
        .setDescription('Days of week (Sun,Mon,Tue,Wed,Thu,Fri,Sat or "Daily")')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('removeevent')
    .setDescription('Remove an event timer')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Event name to remove')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('listevents')
    .setDescription('List all configured events'),
  
  new SlashCommandBuilder()
    .setName('refreshtimers')
    .setDescription('Manually refresh all timer messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
].map(command => command.toJSON());

// Load guild data from database
async function loadGuildData(guildId) {
  const channelId = await db.getServerChannel(guildId);
  const events = await db.getEvents(guildId);
  
  if (channelId) {
    guildChannels.set(guildId, channelId);
  }
  
  if (events.length > 0) {
    guildEvents.set(guildId, events);
  }
}

// Parse time string to get next occurrence
function getNextEventTime(timeStr, days, duration) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  let next = new Date();
  
  next.setHours(hours, minutes, 0, 0);
  
  // Check if event is currently active (started but not ended)
  const eventEnd = new Date(next.getTime() + duration * 60000);
  if (now >= next && now < eventEnd && days.includes(next.getDay())) {
    return next;
  }
  
  // If time has passed today (and event is not active), start checking from tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  
  // Find next valid day
  let attempts = 0;
  while (!days.includes(next.getDay()) && attempts < 7) {
    next.setDate(next.getDate() + 1);
    attempts++;
  }
  
  return next;
}

// Calculate time remaining/elapsed
function getTimeStrings(start, duration) {
  const now = new Date();
  const end = new Date(start.getTime() + duration * 60000);
  
  const diffToStart = start - now;
  const diffToEnd = end - now;
  
  let status, timeStr, color, diff;
  
  if (diffToStart > 0) {
    status = 'inactive';
    diff = diffToStart;
    color = 0x808080; // Gray
  } else if (diffToEnd > 0) {
    status = 'active';
    diff = diffToEnd;
    
    const elapsed = now - start;
    const totalDuration = duration * 60000;
    const progress = elapsed / totalDuration;
    
    if (progress < 0.5) {
      color = 0x00FF00; // Green (0-50%)
    } else if (progress < 0.75) {
      color = 0xFFFF00; // Yellow (50-75%)
    } else {
      color = 0xFF0000; // Red (75-100%)
    }
  } else {
    return null; // Signal to get next event
  }
  
  // Format time difference
  const totalSeconds = Math.floor(Math.abs(diff) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  
  if (status === 'active') {
    timeStr = `${days > 0 ? days + ' Days ' : ''}${hours} Hours ${minutes} Minutes Remaining`;
  } else {
    timeStr = `${days > 0 ? days + ' Days ' : ''}${hours} Hours ${minutes} Minutes Till Event`;
  }
  
  return { status, timeStr, color, start, end };
}

// Create embed for event
function createEventEmbed(event, eventData) {
  const { status, timeStr, color, start } = eventData;
  
  const embed = new EmbedBuilder()
    .setTitle(`⏰ ${event.name}`)
    .setColor(color)
    .setDescription(timeStr)
    .addFields({
      name: status === 'active' ? '🟢 Event Active' : '⏳ Next Event',
      value: `<t:${Math.floor(start.getTime() / 1000)}:F>\n<t:${Math.floor(start.getTime() / 1000)}:R>`,
      inline: false
    })
    .setFooter({ text: `Duration: ${formatDuration(event.duration)}` })
    .setTimestamp();
  
  return embed;
}

// Update event messages for all guilds
async function updateAllEvents() {
  for (const [guildId, channelId] of guildChannels) {
    if (!channelId) continue;
    
    try {
      const channel = await client.channels.fetch(channelId);
      const events = guildEvents.get(guildId) || [];
      
      for (const event of events) {
        try {
          let start = getNextEventTime(event.startTime, event.days, event.duration);
          let eventData = getTimeStrings(start, event.duration);
          
          if (!eventData) {
            start = getNextEventTime(event.startTime, event.days, event.duration);
            eventData = getTimeStrings(start, event.duration);
          }
          
          const embed = createEventEmbed(event, eventData);
          const messageKey = `${guildId}:${event.name}`;
          
          if (eventMessages.has(messageKey)) {
            const msgId = eventMessages.get(messageKey);
            try {
              const msg = await channel.messages.fetch(msgId);
              await msg.edit({ embeds: [embed] });
            } catch (error) {
              const newMsg = await channel.send({ embeds: [embed] });
              eventMessages.set(messageKey, newMsg.id);
            }
          } else {
            const newMsg = await channel.send({ embeds: [embed] });
            eventMessages.set(messageKey, newMsg.id);
          }
        } catch (error) {
          console.error(`Error updating ${event.name} in guild ${guildId}:`, error.message);
        }
      }
    } catch (error) {
      console.error(`Error updating events for guild ${guildId}:`, error.message);
    }
  }
}

// Parse days string to array
function parseDays(daysStr) {
  if (daysStr.toLowerCase() === 'daily') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  
  const dayMap = {
    'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3,
    'thu': 4, 'fri': 5, 'sat': 6
  };
  
  const days = daysStr.toLowerCase().split(',').map(d => d.trim());
  return days.map(day => dayMap[day]).filter(d => d !== undefined);
}

// Format days array to string
function formatDays(days) {
  if (days.length === 7) return 'Daily';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days.map(d => dayNames[d]).join(', ');
}

// Parse duration string (DD:HH:MM or HH:MM) to total minutes
function parseDuration(durationStr) {
  const parts = durationStr.split(':').map(Number);
  
  let days, hours, minutes;
  
  if (parts.length === 3) {
    [days, hours, minutes] = parts;
  } else if (parts.length === 2) {
    days = 0;
    [hours, minutes] = parts;
  } else {
    return null;
  }
  
  const totalMinutes = (days * 1440) + (hours * 60) + minutes;
  return totalMinutes;
}

// Format duration in minutes back to readable format
function formatDuration(totalMinutes) {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  return parts.join(' ') || '0m';
}

// Convert user's local time to server time
function convertUserTimeToServer(timeStr, userOffset) {
  const serverOffset = -(new Date().getTimezoneOffset() / 60);
  const [hours, minutes] = timeStr.split(':').map(Number);
  let adjustedHours = hours - userOffset + serverOffset;
  
  while (adjustedHours < 0) adjustedHours += 24;
  while (adjustedHours >= 24) adjustedHours -= 24;
  
  return `${String(Math.floor(adjustedHours)).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Get timezone name from offset
function getTimezoneName(offset) {
  const timezones = {
    '-12': 'BIT', '-11': 'SST', '-10': 'HST', '-9': 'AKST', '-8': 'PST',
    '-7': 'MST', '-6': 'CST', '-5': 'EST', '-4': 'AST', '-3': 'ART',
    '-2': 'GST', '-1': 'CVT', '0': 'GMT/UTC', '1': 'CET', '2': 'EET',
    '3': 'MSK', '4': 'GST', '5': 'PKT', '5.5': 'IST', '6': 'BST',
    '7': 'ICT', '8': 'CST', '9': 'JST', '10': 'AEST', '11': 'SBT',
    '12': 'NZST', '13': 'TOT', '14': 'LINT'
  };
  
  const sign = offset >= 0 ? '+' : '';
  return `UTC${sign}${offset} (${timezones[String(offset)] || 'Unknown'})`;
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId } = interaction;

  if (commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    
    await db.setServerChannel(guildId, channel.id);
    guildChannels.set(guildId, channel.id);
    
    await interaction.reply({
      content: `✅ Timer channel set to ${channel}. Timers will appear here!`,
      ephemeral: true
    });
    
    // Clear old messages for this guild and update
    const keysToDelete = [];
    for (const [key] of eventMessages) {
      if (key.startsWith(`${guildId}:`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => eventMessages.delete(key));
    
    updateAllEvents();
  }
  
  else if (commandName === 'settimezone') {
    const offset = interaction.options.getInteger('offset');
    await db.setUserTimezone(interaction.user.id, offset);
    
    const serverOffset = -(new Date().getTimezoneOffset() / 60);
    
    await interaction.reply({
      content: `✅ Timezone set to ${getTimezoneName(offset)}\nServer timezone: ${getTimezoneName(serverOffset)}\n\nWhen you create events, times will be automatically converted!`,
      ephemeral: true
    });
  }
  
  else if (commandName === 'addevent') {
    const name = interaction.options.getString('name');
    const userTime = interaction.options.getString('time');
    const durationStr = interaction.options.getString('duration');
    const daysStr = interaction.options.getString('days');
    
    // Get user's timezone offset
    const userOffset = await db.getUserTimezone(interaction.user.id);
    const serverOffset = -(new Date().getTimezoneOffset() / 60);
    
    let time = userTime;
    let timeInfo = '';
    
    if (userOffset !== undefined && userOffset !== null) {
      time = convertUserTimeToServer(userTime, userOffset);
      timeInfo = `\n🌍 Your time: ${userTime} ${getTimezoneName(userOffset)}\n⏰ Server time: ${time} ${getTimezoneName(serverOffset)}`;
    } else {
      timeInfo = `\n⚠️ No timezone set. Using server time. Use \`/settimezone\` to set your timezone.`;
    }
    
    const duration = parseDuration(durationStr);
    if (duration === null || duration <= 0) {
      return interaction.reply({
        content: '❌ Invalid duration format. Use DD:HH:MM (e.g., 01:02:15) or HH:MM (e.g., 02:30)',
        ephemeral: true
      });
    }
    
    if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(userTime)) {
      return interaction.reply({
        content: '❌ Invalid time format. Use HH:MM (e.g., 14:30)',
        ephemeral: true
      });
    }
    
    const days = parseDays(daysStr);
    if (days.length === 0) {
      return interaction.reply({
        content: '❌ Invalid days. Use day names like: Mon,Wed,Fri or "Daily"',
        ephemeral: true
      });
    }
    
    const event = { name, startTime: time, duration, days };
    
    await db.saveEvent(guildId, event);
    
    // Update in-memory cache
    const events = guildEvents.get(guildId) || [];
    const existingIndex = events.findIndex(e => e.name === name);
    if (existingIndex !== -1) {
      events[existingIndex] = event;
    } else {
      events.push(event);
    }
    guildEvents.set(guildId, events);
    
    await interaction.reply({
      content: `✅ ${existingIndex !== -1 ? 'Updated' : 'Added'} event **${name}**${timeInfo}\nDuration: ${formatDuration(duration)} | Days: ${formatDays(days)}`,
      ephemeral: true
    });
    
    updateAllEvents();
  }
  
  else if (commandName === 'removeevent') {
    const name = interaction.options.getString('name');
    
    await db.deleteEvent(guildId, name);
    
    // Update in-memory cache
    const events = guildEvents.get(guildId) || [];
    const filtered = events.filter(e => e.name !== name);
    guildEvents.set(guildId, filtered);
    
    // Delete message if exists
    const messageKey = `${guildId}:${name}`;
    if (eventMessages.has(messageKey)) {
      const channelId = guildChannels.get(guildId);
      if (channelId) {
        try {
          const channel = await client.channels.fetch(channelId);
          const msg = await channel.messages.fetch(eventMessages.get(messageKey));
          await msg.delete();
        } catch (error) {
          console.error('Error deleting message:', error);
        }
      }
      eventMessages.delete(messageKey);
    }
    
    await interaction.reply({
      content: `✅ Removed event **${name}**`,
      ephemeral: true
    });
  }
  
  else if (commandName === 'listevents') {
    const events = guildEvents.get(guildId) || [];
    
    if (events.length === 0) {
      return interaction.reply({
        content: '📋 No events configured yet. Use `/addevent` to add one!',
        ephemeral: true
      });
    }
    
    const channelId = guildChannels.get(guildId);
    
    const embed = new EmbedBuilder()
      .setTitle('📋 Configured Events')
      .setColor(0x5865F2)
      .setDescription(events.map(e => 
        `**${e.name}**\n⏰ ${e.startTime} | ⏳ ${formatDuration(e.duration)} | 📅 ${formatDays(e.days)}`
      ).join('\n\n'))
      .setFooter({ text: `Channel: ${channelId ? 'Set' : 'Not set'}` });
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  else if (commandName === 'refreshtimers') {
    const channelId = guildChannels.get(guildId);
    if (!channelId) {
      return interaction.reply({
        content: '❌ No channel set. Use `/setchannel` first.',
        ephemeral: true
      });
    }
    
    // Clear messages for this guild
    const keysToDelete = [];
    for (const [key] of eventMessages) {
      if (key.startsWith(`${guildId}:`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => eventMessages.delete(key));
    
    updateAllEvents();
    
    await interaction.reply({
      content: '✅ Refreshing all timers...',
      ephemeral: true
    });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Initialize database
  await db.initDatabase();
  console.log('✅ Database initialized');
  
  // Load all guild data
  const guilds = client.guilds.cache.map(g => g.id);
  for (const guildId of guilds) {
    await loadGuildData(guildId);
  }
  console.log(`✅ Loaded data for ${guilds.length} guilds`);
  
  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
  
  // Set up update interval
  setInterval(updateAllEvents, UPDATE_INTERVAL);
  
  // Initial update
  updateAllEvents();
  
  console.log('🤖 Bot ready!');
});

// When bot joins a new guild, load its data
client.on('guildCreate', async (guild) => {
  console.log(`Joined new guild: ${guild.name} (${guild.id})`);
  await loadGuildData(guild.id);
});

client.login(TOKEN);