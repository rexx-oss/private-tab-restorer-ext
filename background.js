let isRestoring = false;
let saveTimer = null;
let inMemoryFlags = {};

// Helper: Check if a URL is a real website
function isRealWebUrl(url) {
  if (typeof url !== "string") return false;
  const u = url.trim().toLowerCase();
  return u.startsWith("http://") || u.startsWith("https://");
}

// Session flag helpers (cleared automatically by Android when browser process exits)
async function getSessionFlag(key) {
  if (chrome.storage && chrome.storage.session) {
    const res = await chrome.storage.session.get(key);
    return res && res[key];
  }
  return inMemoryFlags[key];
}

async function setSessionFlag(key, val) {
  if (chrome.storage && chrome.storage.session) {
    await chrome.storage.session.set({ [key]: val });
  }
  inMemoryFlags[key] = val;
}

// Save active private tabs
function saveCurrentPrivateTabs() {
  if (isRestoring) return;

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;

    const incognitoTabs = tabs.filter((t) => t.incognito);

    // If private mode is not open, do not touch storage (protects normal browsing)
    if (incognitoTabs.length === 0) return;

    // Check if any tab is still resolving its URL
    const anyLoading = incognitoTabs.some(
      (t) => t.status === "loading" && !isRealWebUrl(t.url || t.pendingUrl)
    );
    if (anyLoading) {
      queueSave(1000);
      return;
    }

    const realUrls = incognitoTabs
      .map((t) => t.url || t.pendingUrl)
      .filter((url) => isRealWebUrl(url));

    if (realUrls.length > 0) {
      // We have active websites open -> update storage
      chrome.storage.local.set({ savedPrivateTabs: realUrls });
    } else {
      // You are in Private mode, but closed the last website tab!
      // Clear memory so opening a new fresh tab won't revive the closed tab.
      chrome.storage.local.remove("savedPrivateTabs");
    }
  });
}

function queueSave(delay = 500) {
  if (isRestoring) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentPrivateTabs, delay);
}

// Safe Sequential Restore
async function safeRestore(savedUrls, starterTab) {
  isRestoring = true;
  await setSessionFlag("hasRestoredOnStartup", true);

  try {
    const currentTabs = await new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => resolve(tabs || []));
    });

    const incognitoTabs = currentTabs.filter((t) => t.incognito);
    const openUrls = new Set(
      incognitoTabs
        .map((t) => t.url || t.pendingUrl)
        .filter((url) => isRealWebUrl(url))
    );

    const urlsToOpen = savedUrls.filter((url) => !openUrls.has(url));

    if (urlsToOpen.length === 0) {
      isRestoring = false;
      return;
    }

    for (let i = 0; i < urlsToOpen.length; i++) {
      await new Promise((resolve) => {
        const createProps = {
          url: urlsToOpen[i],
          active: i === urlsToOpen.length - 1
        };
        if (starterTab && typeof starterTab.windowId === "number") {
          createProps.windowId = starterTab.windowId;
        }

        chrome.tabs.create(createProps, () => {
          setTimeout(resolve, 80);
        });
      });
    }

    // Dismiss the startup Speed Dial tab
    if (starterTab && starterTab.id) {
      const startUrl = starterTab.url || starterTab.pendingUrl || "";
      if (!isRealWebUrl(startUrl)) {
        chrome.tabs.remove(starterTab.id, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    }
  } catch (err) {
    console.error("Restore error:", err);
  } finally {
    setTimeout(() => {
      isRestoring = false;
    }, 2500);
  }
}

// Check and restore on launch
async function checkAndRestore() {
  if (isRestoring) return;

  // RULE 1: Only restore ONCE per browser boot.
  // If the browser is already running and you tap '+', this prevents reviving old tabs.
  const alreadyRestored = await getSessionFlag("hasRestoredOnStartup");
  if (alreadyRestored) return;

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;

    const incognitoTabs = tabs.filter((t) => t.incognito);
    if (incognitoTabs.length === 0) return;

    const realWebTabs = incognitoTabs.filter((t) => isRealWebUrl(t.url || t.pendingUrl));
    if (realWebTabs.length > 0) {
      queueSave();
      return;
    }

    chrome.storage.local.get(["savedPrivateTabs"], (res) => {
      const urls = res.savedPrivateTabs;
      if (urls && urls.length > 0 && !isRestoring) {
        safeRestore(urls, incognitoTabs[0]);
      }
    });
  });
}

// Listeners
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito) {
    checkAndRestore();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.incognito) {
    queueSave();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  queueSave();
});

// Popup messaging
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "forceSave") {
    saveCurrentPrivateTabs();
    sendResponse({ ok: true });
  } else if (msg.action === "forceRestore") {
    chrome.storage.local.get(["savedPrivateTabs"], (res) => {
      if (res.savedPrivateTabs) {
        chrome.tabs.query({}, (tabs) => {
          const incognitoTabs = tabs ? tabs.filter((t) => t.incognito) : [];
          safeRestore(res.savedPrivateTabs, incognitoTabs[0]);
        });
      }
    });
    sendResponse({ ok: true });
  }
});

// Run once on background wake-up
checkAndRestore();
