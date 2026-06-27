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
let pageWillReload = false;

window.addEventListener('beforeunload', () => {
  pageWillReload = true;
});

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

async function triggerRetry() {
  await Promise.all(pendingUploadPromises);

  const chatInput = deepQuerySelector('#chat-input');
  const inputText = chatInput ? chatInput.value : '';

  await chrome.storage.local.set({
    retryPending: true,
    savedInputText: inputText
  });

  const cancelBtn = Array.from(document.querySelectorAll('button')).find(
    btn => btn.innerText.trim() === 'Cancel'
  );
  cancelBtn?.click();

  setTimeout(() => {
    if (!pageWillReload) location.reload();
  }, 2000);
}

// ==================== Retry init after reload ====================
async function initRetry() {
  const stored = await chrome.storage.local.get([
    'retryPending',
    'savedInputText',
    'pendingFileUploads',
    'pendingAuth'
  ]);

  if (!stored.retryPending) return;

  await waitForElement('[aria-label="Send Message"]');

  const text = stored.savedInputText || '';
  const files = stored.pendingFileUploads || [];
  const auth = stored.pendingAuth || '';

  if (files.length && auth) {
    for (const fileData of files) {
      const blob = await fetch(fileData.data).then(r => r.blob());
      const formData = new FormData();
      formData.append('file', blob, fileData.name);
      try {
        await fetch('https://chat.z.ai/api/v1/files/', {
          method: 'POST',
          headers: {
            authorization: auth,
            'x-region': 'overseas'
          },
          body: formData,
          credentials: 'include'
        });
      } catch (e) {
        console.error('File re‑upload failed', e);
      }
    }
  }

  const chatInput = deepQuerySelector('#chat-input');
  if (chatInput && text) {
    chatInput.value = text;
    chatInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    chatInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  const sendBtn = document.querySelector('[aria-label="Send Message"] button');
  sendBtn?.click();

  await chrome.storage.local.remove([
    'retryPending',
    'savedInputText',
    'pendingFileUploads',
    'pendingAuth'
  ]);
}

// ==================== Listen for toggle changes ====================
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoRetryEnabled' in changes) {
    autoRetryEnabled = changes.autoRetryEnabled.newValue;
    if (autoRetryEnabled) {
      retryTriggered = false;
      pageWillReload = false;
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
  initRetry().catch(console.error);
})();