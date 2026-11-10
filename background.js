let isRestoring = false;
let saveTimer = null;

// Helper: Check if a URL is a real website
function isRealWebUrl(url) {
  if (typeof url !== "string") return false;
  const u = url.trim().toLowerCase();
  return u.startsWith("http://") || u.startsWith("https://");
}

// Checkpoint 1 & 4: Save active private tabs with Anti-Truncation Guard
function saveCurrentPrivateTabs() {
  if (isRestoring) return;

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;

    const incognitoTabs = tabs.filter((t) => t.incognito);
    if (incognitoTabs.length === 0) return;

    // Check if any tab is still in the middle of loading
    const anyLoading = incognitoTabs.some(
      (t) => t.status === "loading" && !isRealWebUrl(t.url || t.pendingUrl)
    );

    // If tabs are still resolving their URLs, wait and re-queue to prevent truncating the list
    if (anyLoading) {
      queueSave(1000);
      return;
    }

    const realUrls = incognitoTabs
      .map((t) => t.url || t.pendingUrl)
      .filter((url) => isRealWebUrl(url));

    // Only update storage if real websites are found
    if (realUrls.length > 0) {
      chrome.storage.local.set({ savedPrivateTabs: realUrls });
    }
  });
}

function queueSave(delay = 600) {
  if (isRestoring) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentPrivateTabs, delay);
}

// Checkpoint 2 & 3: Safe Sequential Restore with Duplicate Elimination
async function safeRestore(savedUrls, starterTab) {
  isRestoring = true;

  try {
    // Query what is currently open right this millisecond
    const currentTabs = await new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => resolve(tabs || []));
    });

    const incognitoTabs = currentTabs.filter((t) => t.incognito);
    const openUrls = new Set(
      incognitoTabs
        .map((t) => t.url || t.pendingUrl)
        .filter((url) => isRealWebUrl(url))
    );

    // CHECKPOINT: Filter out any URL that is ALREADY open (prevents 8 -> 16 -> 32)
    const urlsToOpen = savedUrls.filter((url) => !openUrls.has(url));

    if (urlsToOpen.length === 0) {
      isRestoring = false;
      return;
    }

    // CHECKPOINT: Create tabs sequentially with an 80ms buffer (prevents dropped tabs)
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

    // Close the blank startup Speed Dial tab once all real tabs have spawned
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
    // CHECKPOINT 5: 3-second cooldown before allowing any save events to run
    setTimeout(() => {
      isRestoring = false;
    }, 3000);
  }
}

// Triggered on launch or tab events
function checkAndRestore() {
  if (isRestoring) return;

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;

    const incognitoTabs = tabs.filter((t) => t.incognito);
    if (incognitoTabs.length === 0) return;

    // If real websites are already open, we are browsing normally — do not restore
    const realWebTabs = incognitoTabs.filter((t) => isRealWebUrl(t.url || t.pendingUrl));
    if (realWebTabs.length > 0) {
      queueSave();
      return;
    }

    // Only restore if the only thing open is a blank/Speed Dial tab
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

// Run once on worker wake-up
checkAndRestore();