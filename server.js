const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isRender = process.env.RENDER === 'true';
const databaseUrl = process.env.DATABASE_URL;
const useMemoryStore = !databaseUrl && !isRender;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let pool = null;

// Local-only fallback so the app can be tried without PostgreSQL.
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
  // connection-string parser cannot override it. Internal Render hostnames
  // do not end in .render.com and continue to use the private connection.
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bbchat_messages_conversation_id_id
    ON bbchat_messages (conversation_id, id);
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
  memory.conversations.push({
    id,
    title: 'Welcome chat',
    created_by: 'System',
    created_at: new Date().toISOString()
  });
  memory.messages.push({
    id: memory.nextMessageId++,
    conversation_id: id,
    sender: 'System',
    body: 'Welcome. Start a conversation or send a message here.',
    created_at: new Date().toISOString()
  });
}

function memoryConversationSummary(conversation) {
  const roomMessages = memory.messages.filter(m => m.conversation_id === conversation.id);
  const latest = roomMessages.at(-1) || null;
  return {
    ...conversation,
    last_message_id: latest ? latest.id : 0,
    last_message_at: latest ? latest.created_at : conversation.created_at,
    last_message_preview: latest ? latest.body.slice(0, 100) : ''
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    if (pool) await pool.query('SELECT 1');
    res.json({ ok: true, storage: useMemoryStore ? 'memory' : 'postgres' });
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
          SELECT LEFT(m2.body, 100)
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

app.get('/api/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.id);
    const after = toPositiveInt(req.query.after, 0);

    if (!conversationId) {
      return res.status(400).json({ error: 'Invalid conversation ID.' });
    }

    if (useMemoryStore) {
      const exists = memory.conversations.some(c => c.id === conversationId);
      if (!exists) return res.status(404).json({ error: 'Conversation not found.' });

      const rows = memory.messages
        .filter(m => m.conversation_id === conversationId && m.id > after)
        .slice(0, 500);
      return res.json(rows);
    }

    const conversation = await pool.query('SELECT id FROM bbchat_conversations WHERE id = $1', [conversationId]);
    if (!conversation.rowCount) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const result = await pool.query(
      `SELECT id, conversation_id, sender, body, created_at
       FROM bbchat_messages
       WHERE conversation_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT 500`,
      [conversationId, after]
    );

    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversationId = toPositiveInt(req.params.id);
    const sender = cleanString(req.body.sender, 80);
    const body = cleanString(req.body.body, 4000);

    if (!conversationId || !sender || !body) {
      return res.status(400).json({ error: 'Conversation, sender, and message are required.' });
    }

    if (useMemoryStore) {
      const exists = memory.conversations.some(c => c.id === conversationId);
      if (!exists) return res.status(404).json({ error: 'Conversation not found.' });

      const row = {
        id: memory.nextMessageId++,
        conversation_id: conversationId,
        sender,
        body,
        created_at: new Date().toISOString()
      };
      memory.messages.push(row);
      return res.status(201).json(row);
    }

    const result = await pool.query(
      `INSERT INTO bbchat_messages (conversation_id, sender, body)
       SELECT id, $2, $3
       FROM bbchat_conversations
       WHERE id = $1
       RETURNING id, conversation_id, sender, body, created_at`,
      [conversationId, sender, body]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
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
    console.log(`Quick Notes Chat listening on port ${PORT}`);
  });
}

start().catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
