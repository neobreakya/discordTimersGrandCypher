const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Configuration file path
const configPath = path.join(__dirname, 'config.json');

// Load or create configuration
let CONFIG = {
  token: process.env.BOT_TOKEN,
  channelId: null,
  updateInterval: 60000,
  events: [],
  userTimezones: {}, // Store user timezone offsets { userId: offsetHours }
};

if (fs.existsSync(configPath)) {
  CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
}

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel for event timers')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The channel to post timers in')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('settimezone')
    .setDescription('Set your timezone for automatic time conversion')
    .addIntegerOption((option) =>
      option
        .setName('offset')
        .setDescription(
          'UTC offset (e.g., +9 for JST, -6 for CST, -5 for EST, +0 for GMT)'
        )
        .setRequired(true)
        .setMinValue(-12)
        .setMaxValue(14)
    ),

  new SlashCommandBuilder()
    .setName('addevent')
    .setDescription('Add a new event timer')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) =>
      option.setName('name').setDescription('Event name').setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('time')
        .setDescription('Start time in 24hr format (HH:MM, e.g., 14:30)')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription(
          'Event duration (DD:HH:MM or HH:MM, e.g., 01:02:15 or 02:30)'
        )
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('days')
        .setDescription('Days of week (Sun,Mon,Tue,Wed,Thu,Fri,Sat or "Daily")')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('removeevent')
    .setDescription('Remove an event timer')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Event name to remove')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('listevents')
    .setDescription('List all configured events'),

  new SlashCommandBuilder()
    .setName('refreshtimers')
    .setDescription('Manually refresh all timer messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
].map((command) => command.toJSON());

// Store message IDs for each event
const eventMessages = new Map();

// Parse time string to get next occurrence
function getNextEventTime(timeStr, days, duration) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  let next = new Date();

  console.log(`Current time: ${now.toLocaleString()}`);

  next.setHours(hours, minutes, 0, 0);

  // Check if event is currently active (started but not ended)
  const eventEnd = new Date(next.getTime() + duration * 60000);
  if (now >= next && now < eventEnd && days.includes(next.getDay())) {
    // Event is active right now, return the start time
    console.log(
      `Event is currently active! Started at: ${next.toLocaleString()}`
    );
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

  console.log(`Next event time: ${next.toLocaleString()}`);

  return next;
}

// Calculate time remaining/elapsed
function getTimeStrings(start, duration) {
  const now = new Date();
  const end = new Date(start.getTime() + duration * 60000);

  const diffToStart = start - now;
  const diffToEnd = end - now;

  console.log(
    `Start: ${start.toLocaleTimeString()}, End: ${end.toLocaleTimeString()}, Now: ${now.toLocaleTimeString()}`
  );
  console.log(
    `Diff to start: ${Math.floor(
      diffToStart / 1000
    )}s, Diff to end: ${Math.floor(diffToEnd / 1000)}s`
  );

  let status, timeStr, color, diff;

  if (diffToStart > 0) {
    // Event hasn't started yet
    status = 'inactive';
    diff = diffToStart;
    color = 0x808080; // Gray
    console.log(
      `Event inactive. Starts in ${Math.floor(
        diffToStart / 1000 / 60
      )} minutes (${Math.floor(diffToStart / 1000)}s)`
    );
  } else if (diffToEnd > 0) {
    // Event is active (start time has passed, end time hasn't)
    status = 'active';
    diff = diffToEnd;

    const elapsed = now - start;
    const totalDuration = duration * 60000;
    const progress = elapsed / totalDuration;

    console.log(
      `Event ACTIVE! Elapsed: ${Math.floor(elapsed / 1000)}s, Progress: ${(
        progress * 100
      ).toFixed(1)}%`
    );

    if (progress < 0.5) {
      color = 0x00ff00; // Green (0-50%)
      console.log('Color: GREEN (0-50%)');
    } else if (progress < 0.75) {
      color = 0xffff00; // Yellow (50-75%)
      console.log('Color: YELLOW (50-75%)');
    } else {
      color = 0xff0000; // Red (75-100%)
      console.log('Color: RED (75-100%)');
    }
  } else {
    // Event has ended, get next occurrence
    console.log('Event ended, getting next occurrence');
    return null; // Signal to get next event
  }

  // Format time difference
  const totalSeconds = Math.floor(Math.abs(diff) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (status === 'active') {
    timeStr = `${
      days > 0 ? days + ' Days ' : ''
    }${hours} Hours ${minutes} Minutes Remaining`;
  } else {
    timeStr = `${
      days > 0 ? days + ' Days ' : ''
    }${hours} Hours ${minutes} Minutes Till Event`;
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
      value: `<t:${Math.floor(start.getTime() / 1000)}:F>\n<t:${Math.floor(
        start.getTime() / 1000
      )}:R>`,
      inline: false,
    })
    .setFooter({ text: `Duration: ${formatDuration(event.duration)}` })
    .setTimestamp();

  return embed;
}

// Update event messages
async function updateEvents() {
  if (!CONFIG.channelId) return;

  try {
    const channel = await client.channels.fetch(CONFIG.channelId);

    for (const event of CONFIG.events) {
      try {
        console.log(`\n--- Updating: ${event.name} ---`);
        let start = getNextEventTime(
          event.startTime,
          event.days,
          event.duration
        );
        let eventData = getTimeStrings(start, event.duration);

        // If event ended, get next occurrence
        if (!eventData) {
          start = getNextEventTime(event.startTime, event.days, event.duration);
          eventData = getTimeStrings(start, event.duration);
        }

        const embed = createEventEmbed(event, eventData);

        // Check if message exists
        if (eventMessages.has(event.name)) {
          const msgId = eventMessages.get(event.name);
          try {
            const msg = await channel.messages.fetch(msgId);
            await msg.edit({ embeds: [embed] });
            console.log(`✅ Updated message for ${event.name}`);
          } catch (error) {
            // Message deleted, create new one
            const newMsg = await channel.send({ embeds: [embed] });
            eventMessages.set(event.name, newMsg.id);
            console.log(`✅ Created new message for ${event.name}`);
          }
        } else {
          // Create new message
          const newMsg = await channel.send({ embeds: [embed] });
          eventMessages.set(event.name, newMsg.id);
          console.log(`✅ Created message for ${event.name}`);
        }
      } catch (error) {
        console.error(`❌ Error updating ${event.name}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error updating events:', error.message);
  }
}

// Parse days string to array
function parseDays(daysStr) {
  if (daysStr.toLowerCase() === 'daily') {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const dayMap = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  const days = daysStr
    .toLowerCase()
    .split(',')
    .map((d) => d.trim());
  return days.map((day) => dayMap[day]).filter((d) => d !== undefined);
}

// Format days array to string
function formatDays(days) {
  if (days.length === 7) return 'Daily';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days.map((d) => dayNames[d]).join(', ');
}

// Parse duration string (DD:HH:MM or HH:MM) to total minutes
function parseDuration(durationStr) {
  const parts = durationStr.split(':').map(Number);

  let days, hours, minutes;

  if (parts.length === 3) {
    // DD:HH:MM format
    [days, hours, minutes] = parts;
  } else if (parts.length === 2) {
    // HH:MM format (backward compatibility)
    days = 0;
    [hours, minutes] = parts;
  } else {
    return null; // Invalid format
  }

  // Convert everything to minutes: days * 1440 + hours * 60 + minutes
  const totalMinutes = days * 1440 + hours * 60 + minutes;

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
  const serverOffset = -(new Date().getTimezoneOffset() / 60); // Server's UTC offset

  const [hours, minutes] = timeStr.split(':').map(Number);

  // Calculate adjustment: remove user offset, add server offset
  let adjustedHours = hours - userOffset + serverOffset;

  // Handle day rollovers
  while (adjustedHours < 0) adjustedHours += 24;
  while (adjustedHours >= 24) adjustedHours -= 24;

  return `${String(Math.floor(adjustedHours)).padStart(2, '0')}:${String(
    minutes
  ).padStart(2, '0')}`;
}

// Get timezone name from offset
function getTimezoneName(offset) {
  const timezones = {
    '-12': 'BIT',
    '-11': 'SST',
    '-10': 'HST',
    '-9': 'AKST',
    '-8': 'PST',
    '-7': 'MST',
    '-6': 'CST',
    '-5': 'EST',
    '-4': 'AST',
    '-3': 'ART',
    '-2': 'GST',
    '-1': 'CVT',
    0: 'GMT/UTC',
    1: 'CET',
    2: 'EET',
    3: 'MSK',
    4: 'GST',
    5: 'PKT',
    5.5: 'IST',
    6: 'BST',
    7: 'ICT',
    8: 'CST',
    9: 'JST',
    10: 'AEST',
    11: 'SBT',
    12: 'NZST',
    13: 'TOT',
    14: 'LINT',
  };

  const sign = offset >= 0 ? '+' : '';
  return `UTC${sign}${offset} (${timezones[String(offset)] || 'Unknown'})`;
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    CONFIG.channelId = channel.id;
    saveConfig();

    await interaction.reply({
      content: `✅ Timer channel set to ${channel}. Timers will appear here!`,
      ephemeral: true,
    });

    // Clear old messages and update
    eventMessages.clear();
    updateEvents();
  } else if (commandName === 'settimezone') {
    const offset = interaction.options.getInteger('offset');
    CONFIG.userTimezones[interaction.user.id] = offset;
    saveConfig();

    const serverOffset = -(new Date().getTimezoneOffset() / 60);

    await interaction.reply({
      content: `✅ Timezone set to ${getTimezoneName(
        offset
      )}\nServer timezone: ${getTimezoneName(
        serverOffset
      )}\n\nWhen you create events, times will be automatically converted!`,
      ephemeral: true,
    });
  } else if (commandName === 'addevent') {
    const name = interaction.options.getString('name');
    const userTime = interaction.options.getString('time');
    const durationStr = interaction.options.getString('duration');
    const daysStr = interaction.options.getString('days');

    // Get user's timezone offset (default to server time if not set)
    const userOffset = CONFIG.userTimezones[interaction.user.id];
    const serverOffset = -(new Date().getTimezoneOffset() / 60);

    // Convert time if user has set their timezone
    let time = userTime;
    let timeInfo = '';

    if (userOffset !== undefined) {
      time = convertUserTimeToServer(userTime, userOffset);
      timeInfo = `\n🌍 Your time: ${userTime} ${getTimezoneName(
        userOffset
      )}\n⏰ Server time: ${time} ${getTimezoneName(serverOffset)}`;
    } else {
      timeInfo = `\n⚠️ No timezone set. Using server time. Use \`/settimezone\` to set your timezone.`;
    }

    // Parse duration
    const duration = parseDuration(durationStr);
    if (duration === null || duration <= 0) {
      return interaction.reply({
        content:
          '❌ Invalid duration format. Use DD:HH:MM (e.g., 01:02:15) or HH:MM (e.g., 02:30)',
        ephemeral: true,
      });
    }

    // Validate time format
    if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(userTime)) {
      return interaction.reply({
        content: '❌ Invalid time format. Use HH:MM (e.g., 14:30)',
        ephemeral: true,
      });
    }

    const days = parseDays(daysStr);
    if (days.length === 0) {
      return interaction.reply({
        content: '❌ Invalid days. Use day names like: Mon,Wed,Fri or "Daily"',
        ephemeral: true,
      });
    }

    // Check if event exists
    const existingIndex = CONFIG.events.findIndex((e) => e.name === name);
    if (existingIndex !== -1) {
      CONFIG.events[existingIndex] = { name, startTime: time, duration, days };
      saveConfig();
      await interaction.reply({
        content: `✅ Updated event **${name}**${timeInfo}\nDuration: ${formatDuration(
          duration
        )} | Days: ${formatDays(days)}`,
        ephemeral: true,
      });
    } else {
      CONFIG.events.push({ name, startTime: time, duration, days });
      saveConfig();
      await interaction.reply({
        content: `✅ Added event **${name}**${timeInfo}\nDuration: ${formatDuration(
          duration
        )} | Days: ${formatDays(days)}`,
        ephemeral: true,
      });
    }

    updateEvents();
  } else if (commandName === 'removeevent') {
    const name = interaction.options.getString('name');
    const index = CONFIG.events.findIndex((e) => e.name === name);

    if (index === -1) {
      return interaction.reply({
        content: `❌ Event **${name}** not found.`,
        ephemeral: true,
      });
    }

    CONFIG.events.splice(index, 1);
    saveConfig();

    // Delete the message if it exists
    if (eventMessages.has(name) && CONFIG.channelId) {
      try {
        const channel = await client.channels.fetch(CONFIG.channelId);
        const msg = await channel.messages.fetch(eventMessages.get(name));
        await msg.delete();
      } catch (error) {
        console.error('Error deleting message:', error);
      }
      eventMessages.delete(name);
    }

    await interaction.reply({
      content: `✅ Removed event **${name}**`,
      ephemeral: true,
    });
  } else if (commandName === 'listevents') {
    if (CONFIG.events.length === 0) {
      return interaction.reply({
        content: '📋 No events configured yet. Use `/addevent` to add one!',
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Configured Events')
      .setColor(0x5865f2)
      .setDescription(
        CONFIG.events
          .map(
            (e) =>
              `**${e.name}**\n⏰ ${e.startTime} | ⏳ ${formatDuration(
                e.duration
              )} | 📅 ${formatDays(e.days)}`
          )
          .join('\n\n')
      )
      .setFooter({ text: `Channel: ${CONFIG.channelId ? 'Set' : 'Not set'}` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } else if (commandName === 'refreshtimers') {
    if (!CONFIG.channelId) {
      return interaction.reply({
        content: '❌ No channel set. Use `/setchannel` first.',
        ephemeral: true,
      });
    }

    eventMessages.clear();
    updateEvents();

    await interaction.reply({
      content: '✅ Refreshing all timers...',
      ephemeral: true,
    });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);

  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log('✅ Slash commands registered!');
    console.log('💡 Commands may take 1-5 minutes to appear in Discord.');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
    return;
  }

  // Set up interval
  setInterval(() => {
    if (CONFIG.channelId && CONFIG.events.length > 0) {
      updateEvents();
    }
  }, CONFIG.updateInterval);

  if (CONFIG.channelId) {
    console.log(`🤖 Bot ready! Timer channel: ${CONFIG.channelId}`);
    if (CONFIG.events.length > 0) {
      updateEvents();
    }
  } else {
    console.log(
      '🤖 Bot ready! Use /setchannel to configure the timer channel.'
    );
  }
});

client.login(CONFIG.token);
