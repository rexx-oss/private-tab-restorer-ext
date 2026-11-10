let isRestoring = false;
let saveTimer = null;

// Helper: Check if a URL is a real website (not vivaldi:// or blank speed dials)
function isRealWebUrl(url) {
  if (typeof url !== "string") return false;
  const u = url.trim().toLowerCase();
  return u.startsWith("http://") || u.startsWith("https://");
}

// 1. Save active private tabs (NEVER wipes storage on startup)
function saveCurrentPrivateTabs() {
  if (isRestoring) return;

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;

    const incognitoTabs = tabs.filter((t) => t.incognito);
    if (incognitoTabs.length === 0) return;

    const realUrls = incognitoTabs
      .map((t) => t.url || t.pendingUrl)
      .filter((url) => isRealWebUrl(url));

    // CRITICAL: ONLY write when real websites exist. 
    // If realUrls is 0 (like when Speed Dial loads on boot), DO NOTHING so saved tabs are never wiped!
    if (realUrls.length > 0) {
      chrome.storage.local.set({ savedPrivateTabs: realUrls });
    }
  });
}

function queueSave(delay = 500) {
  if (isRestoring) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentPrivateTabs, delay);
}

// 2. Safe Sequential Restore (prevents tab multiplication and dropped tabs)
async function safeRestore(savedUrls, starterTab) {
  if (isRestoring) return;
  isRestoring = true;

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

    // Filter out URLs that are ALREADY open
    const urlsToOpen = savedUrls.filter((url) => !openUrls.has(url));

    if (urlsToOpen.length === 0) {
      isRestoring = false;
      return;
    }

    // Open tabs sequentially with 80ms buffer
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
    }, 2000);
  }
}

// 3. Check and restore on launch
function checkAndRestore() {
  if (isRestoring) return;

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;

    const incognitoTabs = tabs.filter((t) => t.incognito);
    if (incognitoTabs.length === 0) return;

    // If real websites are already open, browsing is active -> do not restore
    const realWebTabs = incognitoTabs.filter((t) => isRealWebUrl(t.url || t.pendingUrl));
    if (realWebTabs.length > 0) {
      queueSave();
      return;
    }

    // Only restore if sitting on a fresh blank/Speed Dial tab
    chrome.storage.local.get(["savedPrivateTabs"], (res) => {
      const urls = res.savedPrivateTabs;
      if (urls && urls.length > 0 && !isRestoring) {
        safeRestore(urls, incognitoTabs[0]);
      }
    });
  });
}

// Event: A tab is created
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito) {
    checkAndRestore();
  }
});

// Event: Page finishes or updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.incognito) {
    queueSave();
  }
});

// Event: User closes a tab manually
chrome.tabs.onRemoved.addListener(() => {
  if (isRestoring) return;

  setTimeout(() => {
    if (isRestoring) return;

    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;

      const incognitoTabs = tabs.filter((t) => t.incognito);
      const realUrls = incognitoTabs
        .map((t) => t.url || t.pendingUrl)
        .filter((url) => isRealWebUrl(url));

      if (realUrls.length > 0) {
        // Still have tabs open -> update the list
        chrome.storage.local.set({ savedPrivateTabs: realUrls });
      } else if (incognitoTabs.length > 0) {
        // USER MANUALLY CLOSED THE LAST TAB!
        // Clear storage so opening a new tab doesn't revive the closed tab.
        chrome.storage.local.remove("savedPrivateTabs");
      }
    });
  }, 200);
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

// Run once on worker wake-up
checkAndRestore();
