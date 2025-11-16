const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    // Create events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL,
        start_time VARCHAR(5) NOT NULL,
        duration INTEGER NOT NULL,
        days INTEGER[] NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, name)
      )
    `);

    // Create user timezones table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_timezones (
        user_id VARCHAR(20) PRIMARY KEY,
        timezone_offset INTEGER NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create server configs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS server_configs (
        guild_id VARCHAR(20) PRIMARY KEY,
        channel_id VARCHAR(20),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables created/verified');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Event functions
async function saveEvent(guildId, event) {
  try {
    const query = `
      INSERT INTO events (guild_id, name, start_time, duration, days)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (guild_id, name) 
      DO UPDATE SET start_time = $3, duration = $4, days = $5
      RETURNING *
    `;
    const result = await pool.query(query, [
      guildId, 
      event.name, 
      event.startTime, 
      event.duration, 
      event.days
    ]);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving event:', error);
    throw error;
  }
}

async function getEvents(guildId) {
  try {
    const result = await pool.query(
      'SELECT * FROM events WHERE guild_id = $1 ORDER BY name',
      [guildId]
    );
    return result.rows.map(row => ({
      name: row.name,
      startTime: row.start_time,
      duration: row.duration,
      days: row.days
    }));
  } catch (error) {
    console.error('Error getting events:', error);
    return [];
  }
}

async function deleteEvent(guildId, eventName) {
  try {
    await pool.query(
      'DELETE FROM events WHERE guild_id = $1 AND name = $2',
      [guildId, eventName]
    );
  } catch (error) {
    console.error('Error deleting event:', error);
    throw error;
  }
}

// Server config functions
async function setServerChannel(guildId, channelId) {
  try {
    const query = `
      INSERT INTO server_configs (guild_id, channel_id)
      VALUES ($1, $2)
      ON CONFLICT (guild_id)
      DO UPDATE SET channel_id = $2, updated_at = CURRENT_TIMESTAMP
    `;
    await pool.query(query, [guildId, channelId]);
  } catch (error) {
    console.error('Error setting server channel:', error);
    throw error;
  }
}

async function getServerChannel(guildId) {
  try {
    const result = await pool.query(
      'SELECT channel_id FROM server_configs WHERE guild_id = $1',
      [guildId]
    );
    return result.rows[0]?.channel_id || null;
  } catch (error) {
    console.error('Error getting server channel:', error);
    return null;
  }
}

// User timezone functions
async function setUserTimezone(userId, offset) {
  try {
    const query = `
      INSERT INTO user_timezones (user_id, timezone_offset)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET timezone_offset = $2, updated_at = CURRENT_TIMESTAMP
    `;
    await pool.query(query, [userId, offset]);
  } catch (error) {
    console.error('Error setting user timezone:', error);
    throw error;
  }
}

async function getUserTimezone(userId) {
  try {
    const result = await pool.query(
      'SELECT timezone_offset FROM user_timezones WHERE user_id = $1',
      [userId]
    );
    return result.rows[0]?.timezone_offset;
  } catch (error) {
    console.error('Error getting user timezone:', error);
    return null;
  }
}

module.exports = {
  initDatabase,
  saveEvent,
  getEvents,
  deleteEvent,
  setServerChannel,
  getServerChannel,
  setUserTimezone,
  getUserTimezone
};