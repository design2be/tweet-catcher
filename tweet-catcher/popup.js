const DEFAULT_SETTINGS = {
  apiBase: "http://localhost:8000/api/v2/collector",
  apiKey: "X_COLLECTOR_KEY",
  collectorId: "tweet-catcher"
};

const apiBase = document.getElementById("apiBase");
const apiKey = document.getElementById("apiKey");
const collectorId = document.getElementById("collectorId");
const saveBtn = document.getElementById("saveBtn");
const enableBtn = document.getElementById("enableBtn");
const disableBtn = document.getElementById("disableBtn");

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "The extension did not respond."));
        return;
      }
      resolve(response);
    });
  });
}

function currentWindowId() {
  return new Promise((resolve, reject) => {
    chrome.windows.getCurrent(window => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(window.id);
    });
  });
}

function permissionOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Enter a valid collector API URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Enter a valid collector API URL.");
  }

  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname}${port}/*`;
}

function collectSettings() {
  const nextApiBase = apiBase.value.trim().replace(/\/+$/, "");
  if (!nextApiBase) {
    throw new Error("Enter a valid collector API URL.");
  }
  permissionOrigin(nextApiBase);

  return {
    apiBase: nextApiBase,
    apiKey: apiKey.value.trim() || DEFAULT_SETTINGS.apiKey,
    collectorId: collectorId.value.trim() || DEFAULT_SETTINGS.collectorId
  };
}

function requestApiPermission(origin) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins: [origin] }, granted => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!granted) {
        reject(new Error("API access permission was not granted."));
        return;
      }
      resolve();
    });
  });
}

function saveSettingsFromClick() {
  return new Promise((resolve, reject) => {
    let settings;
    let origin;
    try {
      settings = collectSettings();
      origin = permissionOrigin(settings.apiBase);
    } catch (error) {
      reject(error);
      return;
    }

    const saved = sendMessage({ type: "SAVE_COLLECTOR_SETTINGS", settings });
    const permitted = requestApiPermission(origin);
    saved.then(() => permitted).then(() => resolve(settings)).catch(reject);
  });
}

function renderState(response) {
  const state = response?.state || {};
  const job = response?.job || null;
  const enabled = !!response?.enabled;

  document.getElementById("statusPhase").textContent =
    String(state.phase || (enabled ? "waiting" : "disabled")).replace(/_/g, " ");
  document.getElementById("statusMessage").textContent =
    state.message || (enabled ? "Waiting for a profile…" : "Collector is disabled.");
  document.getElementById("statusProfile").textContent =
    state.profile?.xHandle ? `@${state.profile.xHandle}` : "";
  document.getElementById("acceptedCount").textContent =
    String(state.accepted ?? job?.accepted ?? 0);
  document.getElementById("duplicateCount").textContent =
    String(state.duplicates ?? job?.duplicates ?? 0);
  document.getElementById("rejectedCount").textContent =
    String(state.rejected ?? job?.rejected ?? 0);
  renderPending(state);

  enableBtn.hidden = enabled;
  disableBtn.hidden = !enabled;
  saveBtn.disabled = enabled;
  apiBase.disabled = enabled;
  apiKey.disabled = enabled;
  collectorId.disabled = enabled;
}

function formatPendingTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function renderPending(state) {
  const posts = Array.isArray(state.pendingPosts) ? state.pendingPosts : [];
  const count = Number.isFinite(Number(state.pendingCount))
    ? Number(state.pendingCount)
    : posts.length;
  const list = document.getElementById("pendingList");
  document.getElementById("pendingCount").textContent = String(count);
  list.replaceChildren();

  if (!posts.length) {
    const empty = document.createElement("li");
    empty.className = "pending-empty";
    empty.textContent = "No tweets waiting to send.";
    list.appendChild(empty);
    return;
  }

  posts.forEach(post => {
    const item = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "pending-id";
    const publishedAt = formatPendingTime(post.publishedAt);
    meta.textContent = publishedAt
      ? `${post.externalId || "Tweet"} · ${publishedAt}`
      : (post.externalId || "Tweet");
    const text = document.createElement("p");
    text.textContent = post.text || "No tweet text.";
    item.append(meta, text);
    list.appendChild(item);
  });
}

async function refreshState() {
  try {
    renderState(await sendMessage({
      type: "GET_COLLECTOR_STATE",
      windowId: await currentWindowId()
    }));
  } catch (error) {
    renderState({ state: { phase: "error", message: error.message } });
  }
}

saveBtn.addEventListener("click", () => {
  saveSettingsFromClick()
    .then(() => {
      document.getElementById("statusMessage").textContent = "Settings saved.";
    })
    .catch(error => {
      document.getElementById("statusMessage").textContent = error.message;
    });
});

enableBtn.addEventListener("click", () => {
  saveSettingsFromClick()
    .then(() => currentWindowId())
    .then(windowId => sendMessage({
      type: "ENABLE_COLLECTOR",
      windowId
    }))
    .then(() => refreshState())
    .catch(error => {
      document.getElementById("statusMessage").textContent = error.message;
    });
});

disableBtn.addEventListener("click", async () => {
  try {
    await sendMessage({ type: "DISABLE_COLLECTOR" });
    await refreshState();
  } catch (error) {
    document.getElementById("statusMessage").textContent = error.message;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local"
    && (changes.collectorStates || changes.collectorEnabled || changes.activeCollectionJobs)
  ) {
    refreshState();
  }
});

chrome.storage.local.get("collectorSettings", data => {
  const stored = data.collectorSettings || {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  settings.apiBase = String(settings.apiBase || DEFAULT_SETTINGS.apiBase).trim().replace(/\/+$/, "");
  settings.apiKey = String(settings.apiKey || "").trim() || DEFAULT_SETTINGS.apiKey;
  settings.collectorId = String(settings.collectorId || "").trim() || DEFAULT_SETTINGS.collectorId;
  apiBase.value = settings.apiBase;
  apiKey.value = settings.apiKey;
  collectorId.value = settings.collectorId;
});

refreshState();