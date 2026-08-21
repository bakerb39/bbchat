const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isRender = process.env.RENDER === 'true';
const databaseUrl = process.env.DATABASE_URL;
const useMemoryStore = !databaseUrl && !isRender;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🎉']);
const E2EE_MIME = 'application/x-bbchat-e2ee';
const MAX_ENCRYPTED_BYTES = 7 * 1024 * 1024;

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

// Always revalidate the app shell so a newly deployed HTML page points to the
// current versioned JavaScript and CSS instead of an older cached client.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && (req.path === '/' || req.path.endsWith('.html') || !path.extname(req.path))) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

let pool = null;

const memory = {
  conversations: [],
  messages: [],
  nextConversationId: 1,
  nextMessageId: 1
};

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function toPositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseChangedAfter(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseImageDataUrl(value) {
  if (!value) return null;
  if (typeof value !== 'string') throw new Error('Invalid image data.');

  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('Only PNG, JPEG, WebP, or GIF images are supported.');

  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(mime)) throw new Error('Unsupported image type.');

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('The image is empty.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Images must be 5 MB or smaller.');

  return { mime, buffer };
}

function parseEncryptedData(value) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error('Invalid encrypted message.');
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > MAX_ENCRYPTED_BYTES) throw new Error('Encrypted message is too large.');
  return buffer;
}

function normalizeReactions(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      source = {};
    }
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

  const normalized = {};
  for (const [emoji, users] of Object.entries(source)) {
    if (!ALLOWED_REACTIONS.has(emoji) || !Array.isArray(users)) continue;
    const names = [...new Set(users.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().slice(0, 80)))];
    if (names.length) normalized[emoji] = names;
  }
  return normalized;
}

function toggleReactionValue(value, emoji, sender) {
  const reactions = normalizeReactions(value);
  const current = new Set(reactions[emoji] || []);

  if (current.has(sender)) current.delete(sender);
  else current.add(sender);

  if (current.size) reactions[emoji] = [...current];
  else delete reactions[emoji];

  return reactions;
}

function serializeMessage(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender: row.sender,
    body: row.body || '',
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    edited_at: row.edited_at || null,
    deleted_at: row.deleted_at || null,
    reactions: normalizeReactions(row.reactions),
    image_data: row.image_data ? Buffer.from(row.image_data).toString('base64') : null,
    image_mime: row.image_mime || null,
    image_name: row.image_name || null
  };
}

async function initDatabase() {
  if (useMemoryStore) {
    console.warn('DATABASE_URL not set. Using in-memory local development mode.');
    seedMemory();
    return;
  }

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when running on Render.');
  }

  let connectionString = databaseUrl;
  let ssl;

  // Render's external PostgreSQL URL requires TLS. Strip URL-level SSL
  // options before passing an explicit pg SSL configuration so the
  // connection-string parser cannot override it.
  try {
    const parsedDatabaseUrl = new URL(databaseUrl);
    const isExternalRenderDatabase = parsedDatabaseUrl.hostname.endsWith('.render.com');

    if (isExternalRenderDatabase) {
      parsedDatabaseUrl.searchParams.delete('sslmode');
      parsedDatabaseUrl.searchParams.delete('sslcert');
      parsedDatabaseUrl.searchParams.delete('sslkey');
      parsedDatabaseUrl.searchParams.delete('sslrootcert');
      connectionString = parsedDatabaseUrl.toString();
      ssl = { rejectUnauthorized: false };
    }
  } catch (_error) {
    // Let pg report a clear connection-string error below if the URL is invalid.
  }

  pool = new Pool({
    connectionString,
    ssl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bbchat_conversations (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      created_by VARCHAR(80) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bbchat_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL REFERENCES bbchat_conversations(id) ON DELETE CASCADE,
      sender VARCHAR(80) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
      image_data BYTEA,
      image_mime VARCHAR(80),
      image_name VARCHAR(255)
    );
  `);

  // Existing installs get the newer fields without recreating the table.
  await pool.query(`
    ALTER TABLE bbchat_messages
      ADD COLUMN IF NOT EXISTS image_data BYTEA,
      ADD COLUMN IF NOT EXISTS image_mime VARCHAR(80),
      ADD COLUMN IF NOT EXISTS image_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bbchat_messages_conversation_id_id
    ON bbchat_messages (conversation_id, id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bbchat_messages_conversation_updated
    ON bbchat_messages (conversation_id, updated_at);
  `);

  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM bbchat_conversations');
  if (countResult.rows[0].count === 0) {
    const created = await pool.query(
      `INSERT INTO bbchat_conversations (title, created_by)
       VALUES ($1, $2)
       RETURNING id`,
      ['Welcome chat', 'System']
    );
    await pool.query(
      `INSERT INTO bbchat_messages (conversation_id, sender, body)
       VALUES ($1, $2, $3)`,
      [created.rows[0].id, 'System', 'Welcome. Start a conversation or send a message here.']
    );
  }
}

function seedMemory() {
  if (memory.conversations.length) return;
  const id = memory.nextConversationId++;
  const now = new Date().toISOString();
  memory.conversations.push({
    id,
    title: 'Welcome chat',
    created_by: 'System',
    created_at: now
  });
  memory.messages.push({
    id: memory.nextMessageId++,
    conversation_id: id,
    sender: 'System',
    body: 'Welcome. Start a conversation or send a message here.',
    created_at: now,
    updated_at: now,
    edited_at: null,
    deleted_at: null,
    reactions: {},
    image_data: null,
    image_mime: null,
    image_name: null
  });
}

function memoryConversationSummary(conversation) {
  const roomMessages = memory.messages.filter(m => m.conversation_id === conversation.id);
  const latest = roomMessages.at(-1) || null;
  let preview = '';
  if (latest) {
    if (latest.deleted_at) preview = 'Message deleted';
    else if (latest.body) preview = latest.body.slice(0, 100);
    else if (latest.image_mime === E2EE_MIME) preview = '🔒 Encrypted message';
    else if (latest.image_data) preview = '📷 Photo';
  }

  return {
    ...conversation,
    last_message_id: latest ? latest.id : 0,
    last_message_at: latest ? latest.created_at : conversation.created_at,
    last_message_preview: preview
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    if (pool) await pool.query('SELECT 1');
    res.json({ ok: true, app: 'BB Chat', storage: useMemoryStore ? 'memory' : 'postgres' });
  } catch (error) {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});

app.get('/api/conversations', async (_req, res, next) => {
  try {
    if (useMemoryStore) {
      const rows = memory.conversations
        .map(memoryConversationSummary)
        .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
      return res.json(rows);
    }

    const result = await pool.query(`
      SELECT
        c.id,
        c.title,
        c.created_by,
        c.created_at,
        COALESCE(MAX(m.id), 0)::bigint AS last_message_id,
        COALESCE(MAX(m.created_at), c.created_at) AS last_message_at,
        COALESCE((
          SELECT CASE
            WHEN m2.deleted_at IS NOT NULL THEN 'Message deleted'
            WHEN NULLIF(m2.body, '') IS NOT NULL THEN LEFT(m2.body, 100)
            WHEN m2.image_mime = '${E2EE_MIME}' THEN '🔒 Encrypted message'
            WHEN m2.image_data IS NOT NULL THEN '📷 Photo'
            ELSE ''
          END
          FROM bbchat_messages m2
          WHERE m2.conversation_id = c.id
          ORDER BY m2.id DESC
          LIMIT 1
        ), '') AS last_message_preview
      FROM bbchat_conversations c
      LEFT JOIN bbchat_messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY last_message_at DESC, c.id DESC
      LIMIT 100;
    `);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations', async (req, res, next) => {
  try {
    const title = cleanString(req.body.title, 120);
    const createdBy = cleanString(req.body.createdBy, 80);

    if (!title || !createdBy) {
      return res.status(400).json({ error: 'Conversation title and display name are required.' });
    }

    if (useMemoryStore) {
      const row = {
        id: memory.nextConversationId++,
        title,
        created_by: createdBy,
        created_at: new Date().toISOString()
      };
      memory.conversations.push(row);
      return res.status(201).json(memoryConversationSummary(row));
    }

    const result = await pool.query(
      `INSERT INTO bbchat_conversations (title, created_by)
       VALUES ($1, $2)
       RETURNING id, title, created_by, created_at`,
      [title, createdBy]
    );

    res.status(201).json({
      ...result.rows[0],
      last_message_id: 0,
      last_message_at: result.rows[0].created_at,
      last_message_preview: ''
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/conversations/:id', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.id);

    if (!conversationId) {
      return res.status(400).json({ error: 'Invalid conversation ID.' });
    }

    if (useMemoryStore) {
      const index = memory.conversations.findIndex(c => c.id === conversationId);
      if (index === -1) return res.status(404).json({ error: 'Conversation not found.' });

      memory.conversations.splice(index, 1);
      memory.messages = memory.messages.filter(m => m.conversation_id !== conversationId);
      return res.json({ ok: true, id: conversationId });
    }

    const result = await pool.query(
      'DELETE FROM bbchat_conversations WHERE id = $1 RETURNING id',
      [conversationId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.id);
    const after = toPositiveInt(req.query.after, 0);
    const changedAfter = parseChangedAfter(req.query.changedAfter);

    if (!conversationId) {
      return res.status(400).json({ error: 'Invalid conversation ID.' });
    }

    if (useMemoryStore) {
      const syncTime = new Date().toISOString();
      res.setHeader('X-BBChat-Sync-Time', syncTime);
      const exists = memory.conversations.some(c => c.id === conversationId);
      if (!exists) return res.status(404).json({ error: 'Conversation not found.' });

      const changedAfterMs = changedAfter ? new Date(changedAfter).getTime() : null;
      const rows = memory.messages
        .filter(m => {
          if (m.conversation_id !== conversationId) return false;
          if (m.id > after) return true;
          return changedAfterMs !== null && new Date(m.updated_at || m.created_at).getTime() >= changedAfterMs;
        })
        .slice(0, 500)
        .map(serializeMessage);
      return res.json(rows);
    }

    const conversation = await pool.query('SELECT id FROM bbchat_conversations WHERE id = $1', [conversationId]);
    if (!conversation.rowCount) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    // Use the database clock as the sync boundary so edits/reactions that occur
    // while this request is running are safely picked up on the next poll.
    const syncResult = await pool.query('SELECT clock_timestamp() AS sync_time');
    res.setHeader('X-BBChat-Sync-Time', new Date(syncResult.rows[0].sync_time).toISOString());

    const result = await pool.query(
      `SELECT id, conversation_id, sender, body, created_at, updated_at, edited_at, deleted_at,
              reactions, image_data, image_mime, image_name
       FROM bbchat_messages
       WHERE conversation_id = $1
         AND (
           id > $2
           OR ($3::boolean AND updated_at >= $4::timestamptz)
         )
       ORDER BY id ASC
       LIMIT 500`,
      [conversationId, after, Boolean(changedAfter), changedAfter || '1970-01-01T00:00:00.000Z']
    );

    res.json(result.rows.map(serializeMessage));
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.id);
    const sender = cleanString(req.body.sender, 80);
    const body = cleanString(req.body.body, 4000);
    const imageName = cleanString(req.body.imageName, 255);
    let image = null;
    let encryptedData = null;

    try {
      encryptedData = parseEncryptedData(req.body.encryptedData);
      image = encryptedData ? null : parseImageDataUrl(req.body.imageData);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    if (!conversationId || !sender || (!body && !image && !encryptedData)) {
      return res.status(400).json({ error: 'Conversation, sender, and either a message or photo are required.' });
    }

    if (useMemoryStore) {
      const exists = memory.conversations.some(c => c.id === conversationId);
      if (!exists) return res.status(404).json({ error: 'Conversation not found.' });

      const now = new Date().toISOString();
      const row = {
        id: memory.nextMessageId++,
        conversation_id: conversationId,
        sender,
        body: encryptedData ? '' : body,
        created_at: now,
        updated_at: now,
        edited_at: null,
        deleted_at: null,
        reactions: {},
        image_data: encryptedData || image?.buffer || null,
        image_mime: encryptedData ? E2EE_MIME : (image?.mime || null),
        image_name: encryptedData ? null : (imageName || null)
      };
      memory.messages.push(row);
      return res.status(201).json(serializeMessage(row));
    }

    const result = await pool.query(
      `INSERT INTO bbchat_messages (conversation_id, sender, body, image_data, image_mime, image_name)
       SELECT id, $2, $3, $4, $5, $6
       FROM bbchat_conversations
       WHERE id = $1
       RETURNING id, conversation_id, sender, body, created_at, updated_at, edited_at, deleted_at,
                 reactions, image_data, image_mime, image_name`,
      [conversationId, sender, encryptedData ? '' : body, encryptedData || image?.buffer || null, encryptedData ? E2EE_MIME : (image?.mime || null), encryptedData ? null : (imageName || null)]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    res.status(201).json(serializeMessage(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/conversations/:conversationId/messages/:messageId', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.conversationId);
    const messageId = toPositiveInt(req.params.messageId);
    const sender = cleanString(req.body.sender, 80);
    const body = cleanString(req.body.body, 4000);
    let encryptedData = null;
    try { encryptedData = parseEncryptedData(req.body.encryptedData); }
    catch (error) { return res.status(400).json({ error: error.message }); }

    if (!conversationId || !messageId || !sender) {
      return res.status(400).json({ error: 'Conversation, message, and sender are required.' });
    }

    if (useMemoryStore) {
      const row = memory.messages.find(m => m.id === messageId && m.conversation_id === conversationId);
      if (!row) return res.status(404).json({ error: 'Message not found.' });
      if (row.sender !== sender) return res.status(403).json({ error: 'You can only edit your own messages.' });
      if (row.deleted_at) return res.status(410).json({ error: 'That message has already been deleted.' });
      if (!body && !encryptedData && !row.image_data) return res.status(400).json({ error: 'A message cannot be empty.' });

      const now = new Date().toISOString();
      row.body = encryptedData ? '' : body;
      if (encryptedData) { row.image_data = encryptedData; row.image_mime = E2EE_MIME; row.image_name = null; }
      row.edited_at = now;
      row.updated_at = now;
      return res.json(serializeMessage(row));
    }

    const existing = await pool.query(
      `SELECT sender, image_data, deleted_at
       FROM bbchat_messages
       WHERE id = $1 AND conversation_id = $2`,
      [messageId, conversationId]
    );

    if (!existing.rowCount) return res.status(404).json({ error: 'Message not found.' });
    if (existing.rows[0].sender !== sender) return res.status(403).json({ error: 'You can only edit your own messages.' });
    if (existing.rows[0].deleted_at) return res.status(410).json({ error: 'That message has already been deleted.' });
    if (!body && !encryptedData && !existing.rows[0].image_data) return res.status(400).json({ error: 'A message cannot be empty.' });

    const result = await pool.query(
      `UPDATE bbchat_messages
       SET body = $3, image_data = COALESCE($4, image_data), image_mime = CASE WHEN $4 IS NOT NULL THEN $5 ELSE image_mime END, image_name = CASE WHEN $4 IS NOT NULL THEN NULL ELSE image_name END, edited_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND conversation_id = $2
       RETURNING id, conversation_id, sender, body, created_at, updated_at, edited_at, deleted_at,
                 reactions, image_data, image_mime, image_name`,
      [messageId, conversationId, encryptedData ? '' : body, encryptedData, encryptedData ? E2EE_MIME : null]
    );

    res.json(serializeMessage(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/conversations/:conversationId/messages/:messageId', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.conversationId);
    const messageId = toPositiveInt(req.params.messageId);
    const sender = cleanString(req.body.sender, 80);

    if (!conversationId || !messageId || !sender) {
      return res.status(400).json({ error: 'Conversation, message, and sender are required.' });
    }

    if (useMemoryStore) {
      const row = memory.messages.find(m => m.id === messageId && m.conversation_id === conversationId);
      if (!row) return res.status(404).json({ error: 'Message not found.' });
      if (row.sender !== sender) return res.status(403).json({ error: 'You can only delete your own messages.' });
      if (row.deleted_at) return res.json(serializeMessage(row));

      const now = new Date().toISOString();
      row.body = '';
      row.image_data = null;
      row.image_mime = null;
      row.image_name = null;
      row.reactions = {};
      row.deleted_at = now;
      row.updated_at = now;
      return res.json(serializeMessage(row));
    }

    const existing = await pool.query(
      `SELECT sender, deleted_at
       FROM bbchat_messages
       WHERE id = $1 AND conversation_id = $2`,
      [messageId, conversationId]
    );

    if (!existing.rowCount) return res.status(404).json({ error: 'Message not found.' });
    if (existing.rows[0].sender !== sender) return res.status(403).json({ error: 'You can only delete your own messages.' });

    if (existing.rows[0].deleted_at) {
      const current = await pool.query(
        `SELECT id, conversation_id, sender, body, created_at, updated_at, edited_at, deleted_at,
                reactions, image_data, image_mime, image_name
         FROM bbchat_messages
         WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId]
      );
      return res.json(serializeMessage(current.rows[0]));
    }

    const result = await pool.query(
      `UPDATE bbchat_messages
       SET body = '', image_data = NULL, image_mime = NULL, image_name = NULL,
           reactions = '{}'::jsonb, deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND conversation_id = $2
       RETURNING id, conversation_id, sender, body, created_at, updated_at, edited_at, deleted_at,
                 reactions, image_data, image_mime, image_name`,
      [messageId, conversationId]
    );

    res.json(serializeMessage(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:conversationId/messages/:messageId/reactions', async (req, res, next) => {
  const conversationId = toPositiveInt(req.params.conversationId);
  const messageId = toPositiveInt(req.params.messageId);
  const sender = cleanString(req.body.sender, 80);
  const emoji = typeof req.body.emoji === 'string' ? req.body.emoji : '';

  if (!conversationId || !messageId || !sender || !ALLOWED_REACTIONS.has(emoji)) {
    return res.status(400).json({ error: 'A valid conversation, message, sender, and reaction are required.' });
  }

  if (useMemoryStore) {
    const row = memory.messages.find(m => m.id === messageId && m.conversation_id === conversationId);
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    if (row.deleted_at) return res.status(410).json({ error: 'You cannot react to a deleted message.' });

    row.reactions = toggleReactionValue(row.reactions, emoji, sender);
    row.updated_at = new Date().toISOString();
    return res.json(serializeMessage(row));
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, sender, deleted_at, reactions
       FROM bbchat_messages
       WHERE id = $1 AND conversation_id = $2
       FOR UPDATE`,
      [messageId, conversationId]
    );

    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Message not found.' });
    }
    if (existing.rows[0].deleted_at) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'You cannot react to a deleted message.' });
    }

    const reactions = toggleReactionValue(existing.rows[0].reactions, emoji, sender);
    const result = await client.query(
      `UPDATE bbchat_messages
       SET reactions = $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND conversation_id = $2
       RETURNING id, conversation_id, sender, body, created_at, updated_at, edited_at, deleted_at,
                 reactions, image_data, image_mime, image_name`,
      [messageId, conversationId, JSON.stringify(reactions)]
    );

    await client.query('COMMIT');
    res.json(serializeMessage(result.rows[0]));
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

async function start() {
  await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BB Chat listening on port ${PORT}`);
  });
}

start().catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
