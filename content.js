// ==================== Global flag ====================
let autoRetryEnabled = false;

// ==================== Fetch interceptor ====================
const pendingUploadPromises = [];
const originalFetch = window.fetch;

window.fetch = async function (...args) {
  const [input, init] = args;
  const url = input instanceof Request ? input.url : input.toString();
  const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');

  if (url.includes('/api/v1/files/') && method.toUpperCase() === 'POST') {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
    const authHeader = headers.get('authorization') || '';

    if (init && init.body instanceof FormData) {
      const fileEntries = [];
      for (const [key, value] of init.body.entries()) {
        if (value instanceof File) fileEntries.push({ key, file: value });
      }

      if (fileEntries.length > 0) {
        const capturePromise = (async () => {
          const filesData = [];
          for (const entry of fileEntries) {
            const dataUrl = await new Promise(resolve => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(entry.file);
            });
            filesData.push({
              name: entry.file.name,
              type: entry.file.type,
              data: dataUrl
            });
          }
          await chrome.storage.local.set({
            pendingFileUploads: filesData,
            pendingAuth: authHeader
          });
        })();

        pendingUploadPromises.push(capturePromise);
      }
    }
  }

  return originalFetch.apply(this, args);
};

// ==================== Shadow DOM helper ====================
function deepQuerySelector(selector, root = document) {
  const found = root.querySelector(selector);
  if (found) return found;
  const all = root.querySelectorAll('*');
  for (const el of all) {
    if (el.shadowRoot) {
      const foundDeep = deepQuerySelector(selector, el.shadowRoot);
      if (foundDeep) return foundDeep;
    }
  }
  return null;
}

// ==================== Wait for element ====================
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timeout waiting for ' + selector));
    }, timeout);
  });
}

// ==================== Modal observer ====================
let modalObserver = null;
let retryTriggered = false;

function startModalObserver() {
  if (modalObserver) return;
  modalObserver = new MutationObserver(() => {
    if (retryTriggered || !autoRetryEnabled) return;
    const modalHeading = Array.from(
      document.querySelectorAll('[role="dialog"] h2, [role="dialog"] [role="heading"]')
    ).find(el => el.textContent.includes('Currently in peak hours'));

    if (modalHeading) {
      retryTriggered = true;
      triggerRetry();
    }
  });
  modalObserver.observe(document.body, { childList: true, subtree: true });
}

function stopModalObserver() {
  if (modalObserver) {
    modalObserver.disconnect();
    modalObserver = null;
  }
}

// ==================== Wait for send button enabled ====================
function waitForSendButtonEnabled(timeout = 15000) {
  return new Promise((resolve) => {
    const check = () => {
      const btn = document.querySelector('[aria-label="Send Message"] button');
      if (!btn || btn.offsetParent === null) return null;
      if (btn.disabled || btn.hasAttribute('disabled')) return null;
      if (btn.classList.contains('disabled')) return null;
      return btn;
    };
    const found = check();
    if (found) return resolve(found);

    const observer = new MutationObserver(() => {
      const b = check();
      if (b) { observer.disconnect(); resolve(b); }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'class', 'aria-label']
    });

    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

// ==================== Retry without reload ====================
async function triggerRetry() {
  try {
    await Promise.all(pendingUploadPromises);

    const chatInput = deepQuerySelector('#chat-input');
    const inputText = chatInput ? chatInput.value : '';
    if (inputText) {
      await chrome.storage.local.set({ savedInputText: inputText });
    }

    const cancelBtn = Array.from(document.querySelectorAll('button')).find(
      btn => btn.innerText.trim() === 'Cancel'
    );
    if (!cancelBtn) {
      console.warn('[zai-auto-retry] Cancel button not found, aborting');
      retryTriggered = false;
      return;
    }
    cancelBtn.click();
    console.log('[zai-auto-retry] Clicked Cancel, waiting for send button');

    const sendBtn = await waitForSendButtonEnabled(15000);
    if (!sendBtn) {
      console.warn('[zai-auto-retry] Send button never enabled — aborting');
      retryTriggered = false;
      return;
    }

    const input = deepQuerySelector('#chat-input');
    if (input && inputText && input.value !== inputText) {
      input.value = inputText;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    sendBtn.click();
    console.log('[zai-auto-retry] Resent message');

    setTimeout(() => {
      retryTriggered = false;
      console.log('[zai-auto-retry] Retry lock released');
    }, 8000);
  } catch (e) {
    console.error('[zai-auto-retry] triggerRetry failed', e);
    retryTriggered = false;
  }
}

// ==================== Listen for toggle changes ====================
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoRetryEnabled' in changes) {
    autoRetryEnabled = changes.autoRetryEnabled.newValue;
    if (autoRetryEnabled) {
      retryTriggered = false;
      startModalObserver();
    } else {
      stopModalObserver();
    }
  }
});

// ==================== Initialise ====================
(async () => {
  const { autoRetryEnabled: stored } = await chrome.storage.local.get('autoRetryEnabled');
  autoRetryEnabled = !!stored;
  if (autoRetryEnabled) {
    startModalObserver();
  }
})();