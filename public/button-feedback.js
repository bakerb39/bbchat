(() => {
  const selector = 'button:not(:disabled), [role="button"]:not([aria-disabled="true"]), a.button-link, label.read-anything-file-button';
  let active = null;
  const clear = () => {
    active?.classList.remove('msg-button-pressed');
    active = null;
  };
  document.addEventListener('pointerdown', (event) => {
    clear();
    const target = event.target.closest?.(selector);
    if (!target) return;
    active = target;
    target.classList.add('msg-button-pressed');
  }, { passive: true });
  document.addEventListener('pointerup', clear, { passive: true });
  document.addEventListener('pointercancel', clear, { passive: true });
  window.addEventListener('blur', clear);
})();

(() => {
  const NAV_BUTTON_ID = 'bb-chat-nav-button';
  const STYLE_ID = 'bb-chat-integration-style';
  const DEFAULT_BB_CHAT_URL = 'https://quick-notes-chat.onrender.com';

  function bbChatUrl() {
    const configured = String(
      window.MARK_SET_GO_BB_CHAT_URL
      || localStorage.getItem('markSetGoBbChatUrl')
      || DEFAULT_BB_CHAT_URL
    ).trim();
    return /^https?:\/\//i.test(configured) ? configured : DEFAULT_BB_CHAT_URL;
  }

  function mainNav() {
    return document.querySelector('.site-header nav[aria-label="Main navigation"]');
  }

  function topLevelLabel(node) {
    if (!(node instanceof Element)) return '';
    const source = node.matches('details')
      ? node.querySelector(':scope > summary')
      : node;
    return String(source?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function removeTopLevelThemesMenu() {
    const nav = mainNav();
    if (!nav) return;
    [...nav.children].forEach((node) => {
      if (!(node instanceof Element) || node.id === NAV_BUTTON_ID) return;
      const label = topLevelLabel(node);
      const action = String(
        node.getAttribute('data-action')
        || node.querySelector(':scope > summary')?.getAttribute('data-action')
        || ''
      ).trim();
      const isThemesLabel = /^(?:🎨\s*)?Themes?(?:\s*&\s*Appearance)?$/i.test(label);
      const isThemesAction = /^(?:theme|themes|theme-picker|experience-themes)$/i.test(action);
      if (isThemesLabel || isThemesAction) node.remove();
    });
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .bb-chat-page {
        width: min(1500px, calc(100% - 24px));
        margin: 18px auto 28px;
        padding: 0;
        overflow: hidden;
        background: var(--surface, #fff);
        border: 1px solid var(--border, #d8e0e8);
        border-radius: 14px;
        box-shadow: 0 14px 34px rgba(22, 40, 58, .12);
      }
      .bb-chat-page-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 13px 16px;
        border-bottom: 1px solid var(--border, #d8e0e8);
        background: var(--surface, #fff);
      }
      .bb-chat-page-heading h1 {
        margin: 0;
        font-size: 1.08rem;
        color: var(--ink, #17345c);
      }
      .bb-chat-page-heading p {
        margin: 3px 0 0;
        font-size: .82rem;
        color: var(--muted, #667788);
      }
      .bb-chat-page-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .bb-chat-frame {
        display: block;
        width: 100%;
        height: max(620px, calc(100vh - 190px));
        border: 0;
        background: #fff;
      }
      @media (max-width: 720px) {
        .bb-chat-page {
          width: 100%;
          margin: 0;
          border-left: 0;
          border-right: 0;
          border-radius: 0;
        }
        .bb-chat-page-header {
          align-items: flex-start;
          flex-direction: column;
        }
        .bb-chat-frame {
          height: calc(100vh - 180px);
          min-height: 520px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function closeOpenTopMenus() {
    document.querySelectorAll('.site-header details[open]').forEach((details) => {
      details.removeAttribute('open');
    });
  }

  function checkpointReader() {
    try {
      if (typeof ReaderContinuity !== 'undefined') {
        ReaderContinuity.saveBeforeNavigation?.();
      }
    } catch (_) {}
    try {
      if (typeof stopReader === 'function') stopReader();
    } catch (_) {}
  }

  function renderBBChat() {
    const app = document.querySelector('#app');
    if (!app) return;
    checkpointReader();
    closeOpenTopMenus();
    ensureStyles();

    const url = bbChatUrl();
    const escapedUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    app.dataset.viewKey = 'bb-chat';
    app.innerHTML = `
      <section class="platform-page bb-chat-page" aria-label="BB Chat">
        <header class="bb-chat-page-header">
          <div class="bb-chat-page-heading">
            <h1>BB Chat</h1>
            <p>Discuss books, ideas, passages, and Symposium sessions with other readers.</p>
          </div>
          <div class="bb-chat-page-actions">
            <button type="button" class="secondary" data-action="reader">Return to Reader</button>
            <a class="secondary button-link" href="${escapedUrl}" target="_blank" rel="noopener">Open in new tab</a>
          </div>
        </header>
        <iframe
          class="bb-chat-frame"
          src="${escapedUrl}"
          title="BB Chat"
          loading="eager"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      </section>`;

    app.focus?.({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  function ensureBBChatButton() {
    const nav = mainNav();
    if (!nav || document.getElementById(NAV_BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = NAV_BUTTON_ID;
    button.className = 'top-level-nav-button';
    button.type = 'button';
    button.title = 'Open BB Chat';
    button.setAttribute('aria-label', 'Open BB Chat');
    button.innerHTML = '<span class="nav-icon" aria-hidden="true">◫</span> BB Chat';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      renderBBChat();
    });

    const profile = nav.querySelector(':scope > [data-action="profile-preferences"]');
    const companyMenu = nav.querySelector(':scope > .company-menu');
    nav.insertBefore(button, profile || companyMenu || null);
  }

  function syncMainNavigation() {
    removeTopLevelThemesMenu();
    ensureBBChatButton();
  }

  function scheduleNavigationSync() {
    [0, 60, 250, 800, 1800].forEach((delay) => {
      window.setTimeout(syncMainNavigation, delay);
    });
  }

  function initBBChatIntegration() {
    ensureStyles();
    scheduleNavigationSync();
    window.addEventListener('pageshow', scheduleNavigationSync);
    document.addEventListener('marksetgo:experience-profile-changed', scheduleNavigationSync);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBBChatIntegration, { once: true });
  } else {
    initBBChatIntegration();
  }
})();
