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

1. Put these files in a new GitHub repository.
2. In Render, choose **New > Blueprint**.
3. Connect the repository.
4. Render will read `render.yaml` and create:
   - the Node web service
   - the PostgreSQL database
   - the `DATABASE_URL` connection between them
5. Open the generated `onrender.com` URL in two browsers or devices.
6. Use different display names, enter the same conversation, and send messages.

The app creates its database tables automatically on startup.

## Manual Render setup instead

If you prefer not to use the Blueprint:

- Create a Render PostgreSQL database.
- Create a Node Web Service from the GitHub repo.
- Build command: `npm install`
- Start command: `npm start`
- Add `DATABASE_URL` to the web service using the database's internal connection string.
- Health check path: `/api/health`

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
