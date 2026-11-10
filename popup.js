function render() {
  chrome.storage.local.get(["savedPrivateTabs"], (res) => {
    const urls = res.savedPrivateTabs || [];
    const statusEl = document.getElementById("status");
    const listEl = document.getElementById("urlList");

    statusEl.innerText = `${urls.length} tab(s) saved in memory:`;
    listEl.innerHTML = "";

    if (urls.length === 0) {
      const li = document.createElement("li");
      li.innerText = "(No real web tabs saved yet)";
      listEl.appendChild(li);
    } else {
      urls.forEach((url) => {
        const li = document.createElement("li");
        li.innerText = url;
        listEl.appendChild(li);
      });
    }
  });
}

// Force a save from the popup
document.getElementById("saveNowBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "forceSave" }, () => {
    setTimeout(render, 400);
  });
});

// Manual restore if needed
document.getElementById("restoreNowBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "forceRestore" });
});

// Clear saved session
document.getElementById("clearBtn").addEventListener("click", () => {
  chrome.storage.local.remove("savedPrivateTabs", () => {
    render();
  });
});

// Load immediately on popup open
render();