const POLL_INTERVAL_MS = 2000;
const CONVERSATION_REFRESH_MS = 6000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
  renderedMessageIds: new Set(),
  conversations: [],
  seenConversationMessageIds: readSeenMap(),
  pollingTimer: null,
  conversationTimer: null,
  fetchingMessages: false,
  pendingImage: null
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

    if (!state.activeConversationId && rows.length) {
      await selectConversation(Number(rows[0].id));
    } else if (state.activeConversationId) {
      const stillExists = rows.some(row => Number(row.id) === state.activeConversationId);
      if (!stillExists && rows.length) await selectConversation(Number(rows[0].id));
    }

    if (!preserveStatus) setStatus(state.pollingEnabled ? 'Auto-refresh on · every 2 seconds' : 'Auto-refresh off');
  } catch (error) {
    setStatus(error.message);
  }
}

async function selectConversation(id) {
  if (!id || id === state.activeConversationId && state.renderedMessageIds.size) return;

  state.activeConversationId = id;
  localStorage.setItem('qnc.activeConversationId', String(id));
  state.lastMessageId = 0;
  state.renderedMessageIds.clear();
  el.messages.textContent = '';

  const conversation = state.conversations.find(item => Number(item.id) === id);
  el.conversationTitle.textContent = conversation?.title || `Conversation ${id}`;
  el.messageInput.disabled = false;
  el.photoBtn.disabled = false;
  el.sendBtn.disabled = false;
  clearPendingImage();
  renderConversations();

  await refreshMessages({ forceAll: true, scroll: true });
}

function createMessageNode(message) {
  const article = document.createElement('article');
  article.className = 'message';

  if (message.sender === state.displayName) article.classList.add('mine');
  if (message.sender === 'System') article.classList.add('system');

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const sender = document.createElement('span');
  sender.className = 'message-sender';
  sender.textContent = message.sender;

  const time = document.createElement('time');
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  meta.append(sender, time);

  const content = document.createElement('div');
  content.className = 'message-content';

  if (message.body) {
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = message.body;
    content.appendChild(body);
  }

  if (message.image_data && message.image_mime) {
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
    content.appendChild(imageLink);
  }

  article.append(meta, content);
  return article;
}

function appendMessages(messages, { scroll = false } = {}) {
  if (!messages.length) return;

  const wasNearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;

  for (const message of messages) {
    const id = Number(message.id);
    if (state.renderedMessageIds.has(id)) continue;
    state.renderedMessageIds.add(id);
    state.lastMessageId = Math.max(state.lastMessageId, id);
    el.messages.appendChild(createMessageNode(message));
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

  try {
    if (!silent) setStatus('Checking for new messages…');
    const after = forceAll ? 0 : state.lastMessageId;
    const messages = await api(`/api/conversations/${state.activeConversationId}/messages?after=${after}`);

    if (forceAll) {
      el.messages.textContent = '';
      state.renderedMessageIds.clear();
      state.lastMessageId = 0;
    }

    appendMessages(messages, { scroll });

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
    const message = await api(`/api/conversations/${state.activeConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        sender: state.displayName,
        body,
        imageData: image?.dataUrl || null,
        imageName: image?.name || null
      })
    });

    const empty = el.messages.querySelector('.empty-state');
    if (empty) empty.remove();

    appendMessages([message], { scroll: true });
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
el.refreshBtn.addEventListener('click', () => refreshMessages({ scroll: false }));
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
