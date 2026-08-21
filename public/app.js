const POLL_INTERVAL_MS = 2000;
const CONVERSATION_REFRESH_MS = 6000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const E2EE_MIME = 'application/x-bbchat-e2ee';

function readSeenMap() {
  try {
    return JSON.parse(localStorage.getItem('qnc.seenConversationMessageIds') || '{}');
  } catch {
    return {};
  }
}

const state = {
  displayName: localStorage.getItem('qnc.displayName') || '',
  pollingEnabled: localStorage.getItem('qnc.pollingEnabled') !== 'false',
  activeConversationId: Number(localStorage.getItem('qnc.activeConversationId')) || null,
  lastMessageId: 0,
  lastSyncAt: null,
  renderedMessageIds: new Set(),
  messagesById: new Map(),
  conversations: [],
  seenConversationMessageIds: readSeenMap(),
  pollingTimer: null,
  conversationTimer: null,
  fetchingMessages: false,
  pendingImage: null,
  editingMessageId: null,
  cryptoKeys: new Map()
};

const el = {
  conversationList: document.getElementById('conversationList'),
  conversationTitle: document.getElementById('conversationTitle'),
  connectionStatus: document.getElementById('connectionStatus'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  photoBtn: document.getElementById('photoBtn'),
  imageInput: document.getElementById('imageInput'),
  imagePreview: document.getElementById('imagePreview'),
  imagePreviewImg: document.getElementById('imagePreviewImg'),
  imagePreviewName: document.getElementById('imagePreviewName'),
  removeImageBtn: document.getElementById('removeImageBtn'),
  pollingToggle: document.getElementById('pollingToggle'),
  refreshBtn: document.getElementById('refreshBtn'),
  encryptionBtn: document.getElementById('encryptionBtn'),
  deleteConversationBtn: document.getElementById('deleteConversationBtn'),
  displayNameLabel: document.getElementById('displayNameLabel'),
  changeNameBtn: document.getElementById('changeNameBtn'),
  newConversationBtn: document.getElementById('newConversationBtn'),
  nameDialog: document.getElementById('nameDialog'),
  nameForm: document.getElementById('nameForm'),
  nameInput: document.getElementById('nameInput'),
  conversationDialog: document.getElementById('conversationDialog'),
  conversationForm: document.getElementById('conversationForm'),
  conversationInput: document.getElementById('conversationInput'),
  cancelConversationBtn: document.getElementById('cancelConversationBtn')
};


function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function passphraseStorageKey(conversationId) {
  return `bbchat.e2ee.passphrase.${conversationId}`;
}

async function deriveConversationKey(passphrase, conversationId) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    salt: new TextEncoder().encode(`BBChat-E2EE-v1|${conversationId}`),
    iterations: 250000,
    hash: 'SHA-256'
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function getConversationKey(conversationId, { promptIfMissing = false } = {}) {
  if (state.cryptoKeys.has(conversationId)) return state.cryptoKeys.get(conversationId);
  let passphrase = sessionStorage.getItem(passphraseStorageKey(conversationId)) || '';
  if (!passphrase && promptIfMissing) {
    passphrase = window.prompt('Enter the shared encryption passphrase for this chat. Share it with the other participant outside BB Chat. It is kept only for this browser session.') || '';
    if (passphrase && passphrase.length < 10) {
      setStatus('Use an encryption passphrase of at least 10 characters.');
      return null;
    }
    if (passphrase) sessionStorage.setItem(passphraseStorageKey(conversationId), passphrase);
  }
  if (!passphrase) return null;
  const key = await deriveConversationKey(passphrase, conversationId);
  state.cryptoKeys.set(conversationId, key);
  return key;
}

async function encryptEnvelope(conversationId, payload) {
  const key = await getConversationKey(conversationId, { promptIfMissing: true });
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0); packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

async function decryptMessage(message) {
  if (message.image_mime !== E2EE_MIME || !message.image_data || message.deleted_at) return message;
  const key = await getConversationKey(Number(message.conversation_id));
  if (!key) return { ...message, body: '', image_data: null, image_mime: null, image_name: null, _locked: true, _encryptedData: message.image_data };
  try {
    const packed = base64ToBytes(message.image_data);
    const iv = packed.slice(0, 12);
    const cipher = packed.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    return { ...message, body: payload.body || '', image_data: payload.imageData ? payload.imageData.split(',')[1] : null, image_mime: payload.imageType || null, image_name: payload.imageName || null, _encryptedData: message.image_data, _encrypted: true };
  } catch {
    return { ...message, body: '', image_data: null, image_mime: null, image_name: null, _locked: true, _encryptedData: message.image_data };
  }
}

async function decryptMessages(messages) {
  return Promise.all(messages.map(decryptMessage));
}

function setStatus(text) {
  el.connectionStatus.textContent = text;
}

function saveSeenMap() {
  localStorage.setItem('qnc.seenConversationMessageIds', JSON.stringify(state.seenConversationMessageIds));
}

function formatTime(iso) {
  return new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso));
}

function clearPendingImage() {
  state.pendingImage = null;
  el.imagePreview.hidden = true;
  el.imagePreviewImg.removeAttribute('src');
  el.imagePreviewName.textContent = 'Photo ready to send';
  el.imageInput.value = '';
}

function showPendingImage(file, dataUrl) {
  state.pendingImage = {
    dataUrl,
    name: file.name || 'Pasted photo',
    type: file.type,
    size: file.size
  };
  el.imagePreviewImg.src = dataUrl;
  el.imagePreviewName.textContent = `${state.pendingImage.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
  el.imagePreview.hidden = false;
}

function attachImageFile(file) {
  if (!file) return;
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    setStatus('Use a PNG, JPEG, WebP, or GIF image.');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setStatus('Images must be 5 MB or smaller.');
    return;
  }

  const reader = new FileReader();
  reader.addEventListener('load', () => {
    showPendingImage(file, reader.result);
    setStatus('Photo attached · press Send');
  });
  reader.addEventListener('error', () => setStatus('Could not read that image.'));
  reader.readAsDataURL(file);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }

  return data;
}

async function fetchMessageUpdates(conversationId, after, changedAfter) {
  const params = new URLSearchParams({ after: String(after) });
  if (changedAfter) params.set('changedAfter', changedAfter);

  const response = await fetch(`/api/conversations/${conversationId}/messages?${params.toString()}`);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }

  return {
    messages: Array.isArray(data) ? data : [],
    syncTime: response.headers.get('X-BBChat-Sync-Time') || new Date().toISOString()
  };
}

function renderConversations() {
  el.conversationList.textContent = '';

  for (const conversation of state.conversations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-item';
    if (Number(conversation.id) === state.activeConversationId) button.classList.add('active');

    const nameRow = document.createElement('div');
    nameRow.className = 'conversation-name';

    const title = document.createElement('span');
    title.textContent = conversation.title;
    nameRow.appendChild(title);

    const lastId = Number(conversation.last_message_id || 0);
    const seenId = Number(state.seenConversationMessageIds[conversation.id] || 0);
    if (lastId > seenId && Number(conversation.id) !== state.activeConversationId) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.title = 'New messages';
      nameRow.appendChild(dot);
    }

    const preview = document.createElement('div');
    preview.className = 'conversation-preview';
    preview.textContent = conversation.last_message_preview || 'No messages yet';

    button.append(nameRow, preview);
    button.addEventListener('click', () => selectConversation(Number(conversation.id)));
    el.conversationList.appendChild(button);
  }
}

async function loadConversations({ preserveStatus = false } = {}) {
  try {
    const rows = await api('/api/conversations');
    state.conversations = rows;
    renderConversations();

    if (!rows.length) {
      state.activeConversationId = null;
      localStorage.removeItem('qnc.activeConversationId');
      state.lastMessageId = 0;
      state.lastSyncAt = null;
      state.renderedMessageIds.clear();
      state.messagesById.clear();
      state.editingMessageId = null;
      clearPendingImage();
      el.conversationTitle.textContent = 'No conversations';
      el.messages.innerHTML = '<div class="empty-state">Create a conversation to begin.</div>';
      el.messageInput.disabled = true;
      el.photoBtn.disabled = true;
      el.sendBtn.disabled = true;
      el.deleteConversationBtn.disabled = true;
    } else if (!state.activeConversationId) {
      await selectConversation(Number(rows[0].id));
    } else {
      const stillExists = rows.some(row => Number(row.id) === state.activeConversationId);
      if (!stillExists) {
        await selectConversation(Number(rows[0].id));
      } else if (el.messageInput.disabled) {
        await selectConversation(state.activeConversationId);
      }
    }

    if (!preserveStatus) {
      setStatus(state.pollingEnabled ? 'Auto-refresh on · every 2 seconds' : 'Auto-refresh off');
    }
  } catch (error) {
    setStatus(error.message);
  }
}

async function selectConversation(id) {
  if (!id || (id === state.activeConversationId && state.renderedMessageIds.size)) return;

  state.activeConversationId = id;
  localStorage.setItem('qnc.activeConversationId', String(id));
  state.lastMessageId = 0;
  state.lastSyncAt = null;
  state.renderedMessageIds.clear();
  state.messagesById.clear();
  state.editingMessageId = null;
  el.messages.textContent = '';

  const conversation = state.conversations.find(item => Number(item.id) === id);
  el.conversationTitle.textContent = conversation?.title || `Conversation ${id}`;
  el.messageInput.disabled = false;
  el.photoBtn.disabled = false;
  el.sendBtn.disabled = false;
  el.deleteConversationBtn.disabled = false;
  clearPendingImage();
  renderConversations();

  await refreshMessages({ forceAll: true, scroll: true });
}

function isMine(message) {
  return message.sender === state.displayName && message.sender !== 'System';
}

function closeReactionPickers(exceptMessageId = null) {
  for (const picker of document.querySelectorAll('.reaction-picker:not([hidden])')) {
    if (exceptMessageId && Number(picker.dataset.messageId) === Number(exceptMessageId)) continue;
    picker.hidden = true;
  }
}

function createReactionStrip(message) {
  const reactions = message.reactions && typeof message.reactions === 'object' ? message.reactions : {};
  const entries = REACTIONS
    .map(emoji => [emoji, Array.isArray(reactions[emoji]) ? reactions[emoji] : []])
    .filter(([, users]) => users.length);

  if (!entries.length) return null;

  const strip = document.createElement('div');
  strip.className = 'reaction-strip';

  for (const [emoji, users] of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-pill';
    if (users.includes(state.displayName)) button.classList.add('mine-reaction');
    button.title = users.join(', ');
    button.setAttribute('aria-label', `${emoji} reaction from ${users.length} ${users.length === 1 ? 'person' : 'people'}`);

    const icon = document.createElement('span');
    icon.textContent = emoji;
    const count = document.createElement('span');
    count.textContent = String(users.length);
    button.append(icon, count);

    button.addEventListener('click', event => {
      event.stopPropagation();
      toggleReaction(Number(message.id), emoji);
    });
    strip.appendChild(button);
  }

  return strip;
}

function createMessageImage(message) {
  if (!message.image_data || !message.image_mime) return null;

  const imageLink = document.createElement('a');
  imageLink.className = 'message-image-link';
  imageLink.href = `data:${message.image_mime};base64,${message.image_data}`;
  imageLink.target = '_blank';
  imageLink.rel = 'noopener';
  imageLink.title = 'Open photo';

  const image = document.createElement('img');
  image.className = 'message-image';
  image.src = imageLink.href;
  image.alt = message.image_name || 'Shared photo';
  image.loading = 'lazy';
  imageLink.appendChild(image);
  return imageLink;
}

function createMessageActions(message) {
  if (message.deleted_at || message.sender === 'System') return null;

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  const reactionControl = document.createElement('div');
  reactionControl.className = 'reaction-control';

  const reactButton = document.createElement('button');
  reactButton.type = 'button';
  reactButton.className = 'message-action-button';
  reactButton.textContent = '☺';
  reactButton.title = 'React';
  reactButton.setAttribute('aria-label', 'React to message');

  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.dataset.messageId = String(message.id);
  picker.hidden = true;

  for (const emoji of REACTIONS) {
    const emojiButton = document.createElement('button');
    emojiButton.type = 'button';
    emojiButton.className = 'reaction-option';
    emojiButton.textContent = emoji;
    emojiButton.title = `React ${emoji}`;
    emojiButton.setAttribute('aria-label', `React ${emoji}`);
    emojiButton.addEventListener('click', event => {
      event.stopPropagation();
      picker.hidden = true;
      toggleReaction(Number(message.id), emoji);
    });
    picker.appendChild(emojiButton);
  }

  reactButton.addEventListener('click', event => {
    event.stopPropagation();
    const willOpen = picker.hidden;
    closeReactionPickers(Number(message.id));
    picker.hidden = !willOpen;
  });

  reactionControl.append(reactButton, picker);
  actions.appendChild(reactionControl);

  if (isMine(message)) {
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'message-action-button';
    editButton.textContent = 'Edit';
    editButton.title = 'Edit message';
    editButton.addEventListener('click', event => {
      event.stopPropagation();
      beginEditMessage(Number(message.id));
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'message-action-button danger-text';
    deleteButton.textContent = 'Delete';
    deleteButton.title = 'Delete message';
    deleteButton.addEventListener('click', event => {
      event.stopPropagation();
      deleteMessage(Number(message.id));
    });

    actions.append(editButton, deleteButton);
  }

  return actions;
}

function createEditContent(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-edit-wrap';

  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-input';
  textarea.rows = 3;
  textarea.maxLength = 4000;
  textarea.value = message.body || '';
  textarea.setAttribute('aria-label', 'Edit message');

  const controls = document.createElement('div');
  controls.className = 'message-edit-actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'secondary-button compact-button';
  cancelButton.textContent = 'Cancel';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'primary-button compact-button';
  saveButton.textContent = 'Save';

  cancelButton.addEventListener('click', () => cancelEditMessage(Number(message.id)));
  saveButton.addEventListener('click', () => saveEditMessage(Number(message.id), textarea.value));
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditMessage(Number(message.id));
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      saveEditMessage(Number(message.id), textarea.value);
    }
  });

  controls.append(cancelButton, saveButton);
  wrapper.append(textarea, controls);

  if (message.image_data) {
    const note = document.createElement('div');
    note.className = 'edit-photo-note';
    note.textContent = 'The attached photo will be kept.';
    wrapper.appendChild(note);
  }

  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 0);

  return wrapper;
}

function createMessageNode(message) {
  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.messageId = String(message.id);

  if (message.sender === state.displayName) article.classList.add('mine');
  if (message.sender === 'System') article.classList.add('system');
  if (message.deleted_at) article.classList.add('deleted');
  if (Number(message.id) === state.editingMessageId) article.classList.add('editing');

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const sender = document.createElement('span');
  sender.className = 'message-sender';
  sender.textContent = message.sender;

  const time = document.createElement('time');
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  meta.append(sender, time);

  if (message.edited_at && !message.deleted_at) {
    const edited = document.createElement('span');
    edited.className = 'edited-label';
    edited.textContent = '(edited)';
    meta.appendChild(edited);
  }

  const actions = createMessageActions(message);
  if (actions) article.appendChild(actions);
  article.appendChild(meta);

  const content = document.createElement('div');
  content.className = 'message-content';

  if (message.deleted_at) {
    const deleted = document.createElement('div');
    deleted.className = 'message-body deleted-message-body';
    deleted.textContent = 'This message was deleted.';
    content.appendChild(deleted);
  } else if (message._locked) {
    const locked = document.createElement('div');
    locked.className = 'message-body';
    locked.textContent = '🔒 Encrypted message — use Encryption to unlock';
    content.appendChild(locked);
  } else if (Number(message.id) === state.editingMessageId) {
    content.appendChild(createEditContent(message));
    const image = createMessageImage(message);
    if (image) content.appendChild(image);
  } else {
    if (message.body) {
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = message.body;
      content.appendChild(body);
    }

    const image = createMessageImage(message);
    if (image) content.appendChild(image);
  }

  article.appendChild(content);

  if (!message.deleted_at && Number(message.id) !== state.editingMessageId) {
    const reactionStrip = createReactionStrip(message);
    if (reactionStrip) article.appendChild(reactionStrip);
  }

  return article;
}

function replaceMessageNode(message) {
  const existing = el.messages.querySelector(`[data-message-id="${Number(message.id)}"]`);
  const replacement = createMessageNode(message);
  if (existing) existing.replaceWith(replacement);
  else el.messages.appendChild(replacement);
}

function reconcileMessages(messages, { scroll = false } = {}) {
  if (!messages.length) return;

  const wasNearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;
  const empty = el.messages.querySelector('.empty-state');
  if (empty) empty.remove();

  for (const message of messages) {
    const id = Number(message.id);
    state.lastMessageId = Math.max(state.lastMessageId, id);
    state.messagesById.set(id, message);

    if (id === state.editingMessageId && !message.deleted_at) {
      continue;
    }

    if (state.renderedMessageIds.has(id)) {
      replaceMessageNode(message);
    } else {
      state.renderedMessageIds.add(id);
      el.messages.appendChild(createMessageNode(message));
    }
  }

  state.seenConversationMessageIds[state.activeConversationId] = state.lastMessageId;
  saveSeenMap();

  if (scroll || wasNearBottom) {
    el.messages.scrollTop = el.messages.scrollHeight;
  }
}

async function refreshMessages({ forceAll = false, scroll = false, silent = false } = {}) {
  if (!state.activeConversationId || state.fetchingMessages) return;
  state.fetchingMessages = true;
  const conversationId = state.activeConversationId;

  try {
    if (!silent) setStatus('Checking for new messages…');
    const after = forceAll ? 0 : state.lastMessageId;
    const changedAfter = forceAll ? null : state.lastSyncAt;
    const result = await fetchMessageUpdates(conversationId, after, changedAfter);

    if (conversationId !== state.activeConversationId) return;

    if (forceAll) {
      el.messages.textContent = '';
      state.renderedMessageIds.clear();
      state.messagesById.clear();
      state.lastMessageId = 0;
      state.editingMessageId = null;
    }

    const decryptedMessages = await decryptMessages(result.messages);
    reconcileMessages(decryptedMessages, { scroll });
    state.lastSyncAt = result.syncTime;

    if (!state.renderedMessageIds.size) {
      el.messages.innerHTML = '<div class="empty-state">No messages yet. Start the conversation.</div>';
    }

    if (!silent) {
      setStatus(state.pollingEnabled ? 'Auto-refresh on · every 2 seconds' : 'Auto-refresh off');
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    state.fetchingMessages = false;
  }
}

async function sendMessage() {
  const body = el.messageInput.value.trim();
  const image = state.pendingImage;
  if ((!body && !image) || !state.activeConversationId) return;

  el.sendBtn.disabled = true;
  setStatus('Sending…');

  try {
    const encryptedData = await encryptEnvelope(state.activeConversationId, {
      body,
      imageData: image?.dataUrl || null,
      imageName: image?.name || null,
      imageType: image?.type || null
    });
    if (!encryptedData) return;

    const rawMessage = await api(`/api/conversations/${state.activeConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ sender: state.displayName, encryptedData })
    });
    const message = await decryptMessage(rawMessage);

    reconcileMessages([message], { scroll: true });
    el.messageInput.value = '';
    clearPendingImage();
    await loadConversations({ preserveStatus: true });
    setStatus(state.pollingEnabled ? 'Sent · auto-refresh on' : 'Sent · auto-refresh off');
    el.messageInput.focus();
  } catch (error) {
    setStatus(error.message);
  } finally {
    el.sendBtn.disabled = false;
  }
}

function beginEditMessage(messageId) {
  const message = state.messagesById.get(messageId);
  if (!message || !isMine(message) || message.deleted_at || message._locked) return;

  if (state.editingMessageId && state.editingMessageId !== messageId) {
    const previous = state.messagesById.get(state.editingMessageId);
    state.editingMessageId = null;
    if (previous) replaceMessageNode(previous);
  }

  state.editingMessageId = messageId;
  closeReactionPickers();
  replaceMessageNode(message);
}

function cancelEditMessage(messageId) {
  if (state.editingMessageId !== messageId) return;
  state.editingMessageId = null;
  const message = state.messagesById.get(messageId);
  if (message) replaceMessageNode(message);
}

async function saveEditMessage(messageId, nextBody) {
  const message = state.messagesById.get(messageId);
  if (!message) return;

  const body = nextBody.trim();
  if (!body && !message.image_data) {
    setStatus('A message cannot be empty.');
    return;
  }

  setStatus('Saving edit…');
  try {
    const imageData = message.image_data && message.image_mime ? `data:${message.image_mime};base64,${message.image_data}` : null;
    const encryptedData = await encryptEnvelope(state.activeConversationId, {
      body,
      imageData,
      imageName: message.image_name || null,
      imageType: message.image_mime || null
    });
    if (!encryptedData) return;
    const rawUpdated = await api(`/api/conversations/${state.activeConversationId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sender: state.displayName, encryptedData })
    });
    const updated = await decryptMessage(rawUpdated);
    state.editingMessageId = null;
    reconcileMessages([updated]);
    await loadConversations({ preserveStatus: true });
    setStatus('Message edited');
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteMessage(messageId) {
  const message = state.messagesById.get(messageId);
  if (!message || !isMine(message) || message.deleted_at) return;
  if (!window.confirm('Delete this message?')) return;

  setStatus('Deleting message…');
  try {
    const deleted = await api(`/api/conversations/${state.activeConversationId}/messages/${messageId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sender: state.displayName })
    });
    if (state.editingMessageId === messageId) state.editingMessageId = null;
    reconcileMessages([deleted]);
    await loadConversations({ preserveStatus: true });
    setStatus('Message deleted');
  } catch (error) {
    setStatus(error.message);
  }
}

async function toggleReaction(messageId, emoji) {
  if (!REACTIONS.includes(emoji)) return;
  closeReactionPickers();
  try {
    const updated = await api(`/api/conversations/${state.activeConversationId}/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ sender: state.displayName, emoji })
    });
    reconcileMessages([updated]);
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteConversation() {
  if (!state.activeConversationId) return;

  const conversation = state.conversations.find(
    item => Number(item.id) === state.activeConversationId
  );
  const title = conversation?.title || 'this chat';

  if (!window.confirm(`Delete "${title}" and all of its messages? This cannot be undone.`)) return;

  el.deleteConversationBtn.disabled = true;
  setStatus('Deleting chat…');

  try {
    const deletedId = state.activeConversationId;
    await api(`/api/conversations/${deletedId}`, { method: 'DELETE' });

    delete state.seenConversationMessageIds[deletedId];
    saveSeenMap();
    state.activeConversationId = null;
    localStorage.removeItem('qnc.activeConversationId');
    state.lastMessageId = 0;
    state.lastSyncAt = null;
    state.renderedMessageIds.clear();
    state.messagesById.clear();
    state.editingMessageId = null;
    clearPendingImage();

    await loadConversations({ preserveStatus: true });
    setStatus('Chat deleted');
  } catch (error) {
    el.deleteConversationBtn.disabled = false;
    setStatus(error.message);
  }
}

function restartPolling() {
  clearInterval(state.pollingTimer);
  state.pollingTimer = null;

  if (state.pollingEnabled) {
    state.pollingTimer = setInterval(() => {
      if (!document.hidden) refreshMessages({ silent: true });
    }, POLL_INTERVAL_MS);
  }

  setStatus(state.pollingEnabled ? 'Auto-refresh on · every 2 seconds' : 'Auto-refresh off');
}

function restartConversationRefresh() {
  clearInterval(state.conversationTimer);
  state.conversationTimer = null;

  if (state.pollingEnabled) {
    state.conversationTimer = setInterval(() => {
      if (!document.hidden) loadConversations({ preserveStatus: true });
    }, CONVERSATION_REFRESH_MS);
  }
}

function showNameDialog() {
  el.nameInput.value = state.displayName;
  el.nameDialog.showModal();
  setTimeout(() => el.nameInput.focus(), 0);
}

function showConversationDialog() {
  el.conversationInput.value = '';
  el.conversationDialog.showModal();
  setTimeout(() => el.conversationInput.focus(), 0);
}

el.nameDialog.addEventListener('cancel', event => {
  if (!state.displayName) event.preventDefault();
});

el.nameForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = el.nameInput.value.trim().slice(0, 80);
  if (!name) return;
  state.displayName = name;
  localStorage.setItem('qnc.displayName', name);
  el.displayNameLabel.textContent = name;
  el.nameDialog.close();

  // Ownership and reaction highlighting are display-name based in this simple v1.
  for (const message of state.messagesById.values()) replaceMessageNode(message);
});

el.conversationForm.addEventListener('submit', async event => {
  event.preventDefault();
  const title = el.conversationInput.value.trim();
  if (!title) return;

  try {
    const created = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title, createdBy: state.displayName })
    });
    el.conversationDialog.close();
    await loadConversations({ preserveStatus: true });
    await selectConversation(Number(created.id));
  } catch (error) {
    setStatus(error.message);
  }
});

el.cancelConversationBtn.addEventListener('click', () => el.conversationDialog.close());
el.newConversationBtn.addEventListener('click', showConversationDialog);
el.changeNameBtn.addEventListener('click', showNameDialog);
el.encryptionBtn.addEventListener('click', async () => {
  if (!state.activeConversationId) return;
  const passphrase = window.prompt('Enter the shared encryption passphrase for this chat (at least 10 characters). It is kept only for this browser session.') || '';
  if (!passphrase) return;
  if (passphrase.length < 10) return setStatus('Use an encryption passphrase of at least 10 characters.');
  sessionStorage.setItem(passphraseStorageKey(state.activeConversationId), passphrase);
  state.cryptoKeys.delete(state.activeConversationId);
  await getConversationKey(state.activeConversationId);
  await refreshMessages({ forceAll: true, scroll: false, silent: true });
  setStatus('🔒 End-to-end encryption unlocked for this session');
});
el.refreshBtn.addEventListener('click', () => refreshMessages({ scroll: false }));
el.deleteConversationBtn.addEventListener('click', deleteConversation);
el.sendBtn.addEventListener('click', sendMessage);
el.photoBtn.addEventListener('click', () => el.imageInput.click());
el.removeImageBtn.addEventListener('click', clearPendingImage);
el.imageInput.addEventListener('change', () => attachImageFile(el.imageInput.files?.[0]));

el.messageInput.addEventListener('paste', event => {
  const imageItem = Array.from(event.clipboardData?.items || []).find(
    item => item.kind === 'file' && item.type.startsWith('image/')
  );
  if (!imageItem) return;

  const file = imageItem.getAsFile();
  if (!file) return;
  event.preventDefault();
  attachImageFile(file);
});

el.messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

el.pollingToggle.addEventListener('change', () => {
  state.pollingEnabled = el.pollingToggle.checked;
  localStorage.setItem('qnc.pollingEnabled', String(state.pollingEnabled));
  if (state.pollingEnabled) refreshMessages({ silent: true });
  restartPolling();
  restartConversationRefresh();
});

document.addEventListener('click', event => {
  if (!event.target.closest('.reaction-control')) closeReactionPickers();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadConversations({ preserveStatus: true });
    if (state.pollingEnabled) refreshMessages({ silent: true });
  }
});

async function init() {
  el.pollingToggle.checked = state.pollingEnabled;
  el.displayNameLabel.textContent = state.displayName || 'Not set';

  if (!state.displayName) showNameDialog();

  await loadConversations();
  restartPolling();
  restartConversationRefresh();
}

init();
