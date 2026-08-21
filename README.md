# Quick Notes Chat

A small multi-user chat app designed for Render. It uses ordinary HTTP polling rather than WebSockets.

## Included in v1

- Multiple named conversations
- Multiple users using simple display names
- PostgreSQL message history
- Auto-refresh toggle (on by default)
- Polls the active conversation every 2 seconds
- Manual Refresh button
- Sends only messages newer than the browser's last message ID
- Basic unread indicators in the conversation list
- Remembers display name, selected conversation, and polling preference in the browser
- Mobile-friendly layout
- Local in-memory development fallback when `DATABASE_URL` is not set
- Paste photos directly into the message box with Ctrl+V / Cmd+V
- Optional Photo button for choosing an image file
- PNG, JPEG, WebP, and GIF up to 5 MB

## Shared Render database safety

This version is intentionally configured to **reuse an existing Render PostgreSQL database** instead of creating a second free-tier database.

Its tables are uniquely prefixed so they stay separate from other applications using the same database. Photo bytes are stored only in `bbchat_messages`:

```text
bbchat_conversations
bbchat_messages
```

The app creates only those tables and its own `idx_bbchat_messages_conversation_id_id` index on startup.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Without `DATABASE_URL`, local development uses temporary in-memory storage. Restarting the Node process clears those local messages.

To use PostgreSQL locally, set:

```bash
DATABASE_URL=postgresql://...
```

## Deploy to Render with the Blueprint

1. Put these files in the `bbchat` GitHub repository (with `render.yaml` at the repo root).
2. In Render, choose **New > Blueprint** and connect `bakerb39/bbchat`.
3. Render reads `render.yaml` and creates only the Node web service. It will **not** try to create another PostgreSQL database.
4. Because `DATABASE_URL` is marked `sync: false`, provide your existing database URL. For the current setup, use the **External Database URL** because the chat service is connecting across Render's public database endpoint.
5. Deploy the Blueprint.
6. Open the generated `onrender.com` URL in two browsers or devices.
7. Use different display names, enter the same conversation, and send messages.

### Finding the existing Render database URL

In Render, open the existing PostgreSQL database and copy its **External Database URL** for the current chat setup. The server explicitly enables TLS for external `*.render.com` PostgreSQL hosts.

Do not commit the database URL to GitHub.

## Manual Render setup instead

If you prefer not to use the Blueprint:

- Create the Node Web Service from the GitHub repo.
- Build command: `npm install`
- Start command: `npm start`
- Add `DATABASE_URL` to the web service using the existing database's External Database URL for the current setup.
- Health check path: `/api/health`

The app creates its `bbchat_*` tables automatically on startup.

## Polling behavior

The active chat checks for new messages every 2 seconds while Auto-refresh is enabled:

```text
GET /api/conversations/:id/messages?after=<lastMessageId>
```

The server returns only newer messages. Turning Auto-refresh off stops that 2-second polling. The Refresh button still works manually.

While Auto-refresh is ON, the conversation sidebar refreshes every 6 seconds so it can show new-message dots in other conversations. Turning Auto-refresh OFF stops both recurring timers. The app pauses automatic checks while the browser tab is hidden and immediately catches up when the tab becomes visible again if Auto-refresh is enabled.

## API

- `GET /api/health`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:id/messages?after=123`
- `POST /api/conversations/:id/messages`

## Good next additions

- Clerk authentication
- Invite-only conversations
- Edit/delete messages
- Presence ("Brian is viewing")
- Attachments
- Search
- Connect a Mark, Set, Go Random Note to a conversation
- Replace polling with WebSockets later if usage grows
