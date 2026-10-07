const DEFAULT_SETTINGS = {
  apiBase: "http://localhost:8000/api/v2/collector",
  apiKey: "X_COLLECTOR_KEY",
  collectorId: "tweet-catcher"
};
const CLAIM_INTERVAL_MS = 5000;

const claimingWindows = new Set();
const finishingJobs = new Set();
let storageMutation = Promise.resolve();

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function normalizeApiBase(value) {
  return String(value || DEFAULT_SETTINGS.apiBase).trim().replace(/\/+$/, "");
}

function normalizeSettings(input) {
  const source = input || {};
  return {
    apiBase: normalizeApiBase(source.apiBase),
    apiKey: String(source.apiKey || "").trim() || DEFAULT_SETTINGS.apiKey,
    collectorId: String(source.collectorId || "").trim() || DEFAULT_SETTINGS.collectorId
  };
}

async function getSettings() {
  const stored = await storageGet("collectorSettings");
  return normalizeSettings(stored.collectorSettings);
}

function mutateStoredMap(key, callback) {
  const operation = storageMutation.catch(() => {}).then(async () => {
    const stored = await storageGet(key);
    const map = Object.assign({}, stored[key] || {});
    const result = callback(map);
    await storageSet({ [key]: map });
    return result;
  });
  storageMutation = operation.then(() => undefined, () => undefined);
  return operation;
}

async function storedMap(key) {
  await storageMutation;
  const stored = await storageGet(key);
  return stored[key] || {};
}

function windowKey(windowId) {
  return String(windowId);
}

async function jobForWindow(windowId) {
  const jobs = await storedMap("activeCollectionJobs");
  return jobs[windowKey(windowId)] || null;
}

async function setWindowJob(windowId, job) {
  return mutateStoredMap("activeCollectionJobs", jobs => {
    const key = windowKey(windowId);
    if (job) {
      jobs[key] = job;
    } else {
      delete jobs[key];
    }
    return job;
  });
}

async function mutateWindowJob(windowId, callback) {
  return mutateStoredMap("activeCollectionJobs", jobs => {
    const key = windowKey(windowId);
    const next = callback(jobs[key] || null);
    if (next) {
      jobs[key] = next;
    } else {
      delete jobs[key];
    }
    return next;
  });
}

async function updateState(windowId, patch) {
  return mutateStoredMap("collectorStates", states => {
    const key = windowKey(windowId);
    const next = Object.assign({}, states[key] || {}, patch, {
      updatedAt: new Date().toISOString()
    });
    states[key] = next;
    return next;
  });
}

function unwrapResponse(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, "data")
    ? payload.data
    : payload;
}

function responseError(payload, fallback) {
  if (payload && Array.isArray(payload.errors) && payload.errors.length) {
    return payload.errors.join(" ");
  }
  if (payload && Array.isArray(payload.messages) && payload.messages.length) {
    return payload.messages.join(" ");
  }
  return fallback;
}

async function apiRequest(path, body, job) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("Set the collector API key in the extension first.");
  }

  const headers = {
    "Authorization": `Bearer ${settings.apiKey}`,
    "Content-Type": "application/json"
  };
  if (job?.leaseToken) {
    headers["X-Collection-Lease"] = job.leaseToken;
  }

  const response = await fetch(`${settings.apiBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {})
  });

  if (response.status === 204) {
    return null;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Collector API returned HTTP ${response.status}.`);
  }

  if (!response.ok) {
    throw new Error(responseError(payload, `Collector API returned HTTP ${response.status}.`));
  }

  return unwrapResponse(payload);
}

function isXUrl(value) {
  try {
    return new URL(value).hostname === "x.com";
  } catch (error) {
    return false;
  }
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function queryTabs(query) {
  return new Promise(resolve => chrome.tabs.query(query, resolve));
}

async function activeXTab(windowId) {
  const tabs = await queryTabs({ active: true, windowId: Number(windowId) });
  const tab = tabs[0] || null;
  return tab && isXUrl(tab.url) ? tab : null;
}

async function activeXTabs() {
  const tabs = await queryTabs({ active: true });
  return tabs.filter(tab => tab.windowId >= 0 && isXUrl(tab.url));
}

async function openProfile(job) {
  let tab;
  try {
    tab = await getTab(job.tabId);
  } catch (error) {
    throw new Error("The X tab for this window is no longer available.");
  }

  if (tab.windowId !== job.windowId || !isXUrl(tab.url)) {
    throw new Error("The X tab navigated away before collection started.");
  }

  await chrome.tabs.update(tab.id, { url: job.profile.url });
  await updateState(job.windowId, {
    phase: "opening_profile",
    message: `Opening @${job.profile.xHandle}`,
    profile: job.profile,
    jobId: job.jobId,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    pendingCount: 0,
    pendingPosts: [],
    onboardingState: "loading"
  });
}

async function claimNext(windowId, preferredTabId = null) {
  const key = windowKey(windowId);
  if (claimingWindows.has(key) || await jobForWindow(windowId)) {
    return;
  }

  const stored = await storageGet("collectorEnabled");
  if (!stored.collectorEnabled) {
    return;
  }

  let tab = null;
  if (preferredTabId !== null) {
    try {
      const preferred = await getTab(preferredTabId);
      if (preferred.windowId === Number(windowId) && isXUrl(preferred.url)) {
        tab = preferred;
      }
    } catch (error) {
      // Fall back to the active tab in this window.
    }
  }
  tab = tab || await activeXTab(windowId);
  if (!tab) {
    await updateState(windowId, {
      phase: "waiting_for_x",
      message: "Open X in this window to collect the next profile…"
    });
    return;
  }

  claimingWindows.add(key);
  await updateState(windowId, { phase: "claiming", message: "Looking for a profile…" });

  try {
    const settings = await getSettings();
    const claimed = await apiRequest("/claim", {
      collectorId: settings.collectorId,
      windowId: key
    });
    if (!claimed) {
      await updateState(windowId, {
        phase: "waiting",
        message: "Waiting for the next profile…",
        profile: null,
        jobId: null
      });
      return;
    }

    const job = {
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      leaseExpiresAt: claimed.leaseExpiresAt,
      mode: claimed.mode === "update" ? "update" : "onboarding",
      profile: claimed.profile,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      windowId: tab.windowId,
      tabId: tab.id
    };
    await setWindowJob(windowId, job);
    await openProfile(job);
  } catch (error) {
    if (await jobForWindow(windowId)) {
      await failJob(windowId, error.message, true);
    } else {
      await updateState(windowId, { phase: "error", message: error.message });
    }
  } finally {
    claimingWindows.delete(key);
  }
}

async function claimAllWindows() {
  const tabs = await activeXTabs();
  for (const tab of tabs) {
    await claimNext(tab.windowId, tab.id);
  }
}

async function senderJob(sender) {
  if (!sender.tab) {
    return null;
  }
  const job = await jobForWindow(sender.tab.windowId);
  return job && job.tabId === sender.tab.id ? job : null;
}

async function uploadBatch(sender, posts) {
  const job = await senderJob(sender);
  if (!job) {
    throw new Error("There is no active collection job for this window.");
  }

  const result = await apiRequest(`/${job.jobId}/posts`, { posts }, job);
  const updatedJob = await mutateWindowJob(job.windowId, current => {
    if (!current || current.jobId !== job.jobId) {
      return current;
    }
    current.accepted = (Number(current.accepted) || 0) + (Number(result.accepted) || 0);
    current.duplicates = (Number(current.duplicates) || 0) + (Number(result.duplicates) || 0);
    current.rejected = (Number(current.rejected) || 0) + (Number(result.rejected) || 0);
    current.leaseExpiresAt = result.leaseExpiresAt || current.leaseExpiresAt;
    return current;
  });
  if (!updatedJob || updatedJob.jobId !== job.jobId) {
    throw new Error("The collection job ended while its posts were uploading.");
  }
  await updateState(job.windowId, {
    phase: "collecting",
    message: result.stop ? "Known post boundary reached." : `Collecting @${job.profile.xHandle}`,
    accepted: updatedJob.accepted,
    duplicates: updatedJob.duplicates,
    rejected: updatedJob.rejected
  });
  return result;
}

async function heartbeat(sender) {
  const job = await senderJob(sender);
  if (!job) {
    return null;
  }
  const result = await apiRequest(`/${job.jobId}/heartbeat`, {}, job);
  await mutateWindowJob(job.windowId, current => {
    if (current && current.jobId === job.jobId) {
      current.leaseExpiresAt = result.leaseExpiresAt;
    }
    return current;
  });
  return result;
}

async function completeJob(sender, reason, hasMore) {
  const job = await senderJob(sender);
  if (!job || finishingJobs.has(job.jobId)) {
    return;
  }
  finishingJobs.add(job.jobId);
  let shouldClaimNext = false;

  try {
    const result = await apiRequest(
      `/${job.jobId}/complete`,
      { reason: reason || "timeline_exhausted", hasMore: !!hasMore },
      job
    );
    hasMore = !!result.hasMore;
    await setWindowJob(job.windowId, null);
    await updateState(job.windowId, {
      phase: "completed",
      message: hasMore
        ? `Paused @${job.profile.xHandle}; more posts remain.`
        : `Finished @${job.profile.xHandle}`,
      onboardingState: result.onboardingState,
      profile: job.profile,
      jobId: null,
      pendingCount: 0,
      pendingPosts: []
    });

    const stored = await storageGet("collectorEnabled");
    shouldClaimNext = !!stored.collectorEnabled;
  } finally {
    finishingJobs.delete(job.jobId);
  }

  if (shouldClaimNext) {
    await claimNext(job.windowId, job.tabId);
  }
}

async function failJob(windowId, message, recoverable = true, knownJob = null) {
  const job = knownJob || await jobForWindow(windowId);
  if (job) {
    try {
      await apiRequest(
        `/${job.jobId}/fail`,
        { message: message || "Browser collector stopped.", recoverable },
        job
      );
    } catch (error) {
      message = `${message || "Collector stopped."} ${error.message}`;
    }
  }

  await setWindowJob(windowId, null);
  await updateState(windowId, { phase: "error", message: message || "Collector stopped." });
}

async function disableCollector() {
  await storageSet({ collectorEnabled: false });
  const jobs = await storedMap("activeCollectionJobs");

  for (const job of Object.values(jobs)) {
    try {
      await chrome.tabs.sendMessage(job.tabId, { type: "STOP_COLLECTION" });
    } catch (error) {
      // The X tab may already be closed or navigating.
    }
  }
  for (const job of Object.values(jobs)) {
    await failJob(job.windowId, "Collection disabled by the user.", true, job);
  }

  const states = await storedMap("collectorStates");
  const windowIds = new Set([...Object.keys(states), ...Object.keys(jobs)]);
  for (const windowId of windowIds) {
    await updateState(windowId, {
      phase: "disabled",
      message: "Collector is disabled.",
      profile: null,
      jobId: null,
      pendingCount: 0,
      pendingPosts: []
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = async () => {
    switch (message?.type) {
      case "SAVE_COLLECTOR_SETTINGS": {
        const settings = normalizeSettings(message.settings);
        await storageSet({ collectorSettings: settings });
        return { ok: true, settings };
      }

      case "ENABLE_COLLECTOR":
        await storageSet({ collectorEnabled: true });
        if (message.windowId !== undefined) {
          await updateState(message.windowId, {
            phase: "waiting",
            message: "Waiting for the next profile…"
          });
        }
        await claimAllWindows();
        return { ok: true };

      case "DISABLE_COLLECTOR":
        await disableCollector();
        return { ok: true };

      case "COLLECTOR_READY": {
        const job = await senderJob(sender);
        return { ok: true, job };
      }

      case "UPLOAD_POSTS":
        return { ok: true, result: await uploadBatch(sender, message.posts || []) };

      case "COLLECTION_STARTED": {
        const job = await senderJob(sender);
        if (job) {
          await updateState(job.windowId, {
            phase: "collecting",
            message: `Collecting @${job.profile.xHandle}`,
            pendingCount: 0,
            pendingPosts: []
          });
        }
        return { ok: true };
      }

      case "PENDING_POSTS": {
        const job = await senderJob(sender);
        if (job) {
          const posts = Array.isArray(message.posts) ? message.posts.slice(0, 40) : [];
          await updateState(job.windowId, {
            pendingCount: Number(message.count) || posts.length,
            pendingPosts: posts
          });
        }
        return { ok: true };
      }

      case "COLLECTOR_HEARTBEAT":
        return { ok: true, result: await heartbeat(sender) };

      case "COMPLETE_COLLECTION":
        await completeJob(sender, message.reason, message.hasMore);
        return { ok: true };

      case "FAIL_COLLECTION": {
        const job = await senderJob(sender);
        if (job) {
          await failJob(job.windowId, message.message, message.recoverable !== false, job);
        }
        return { ok: true };
      }

      case "GET_COLLECTOR_STATE": {
        const windowId = message.windowId;
        const [states, jobs, stored] = await Promise.all([
          storedMap("collectorStates"),
          storedMap("activeCollectionJobs"),
          storageGet("collectorEnabled")
        ]);
        const state = states[windowKey(windowId)] || null;
        return {
          ok: true,
          state: state || {
            phase: stored.collectorEnabled ? "waiting" : "disabled",
            message: stored.collectorEnabled
              ? "Waiting for a profile in this window…"
              : "Collector is disabled."
          },
          enabled: !!stored.collectorEnabled,
          job: jobs[windowKey(windowId)] || null
        };
      }

      default:
        return { ok: false, error: "Unknown extension message." };
    }
  };

  respond()
    .then(sendResponse)
    .catch(async error => {
      const windowId = sender.tab?.windowId ?? message?.windowId;
      if (windowId !== undefined) {
        await updateState(windowId, { phase: "error", message: error.message });
      }
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const jobs = await storedMap("activeCollectionJobs");
  const job = Object.values(jobs).find(candidate => candidate.tabId === tabId);
  if (job) {
    await failJob(job.windowId, "The X collection tab was closed.", true, job);
  }
});

(async function resumeCollector() {
  const stored = await storageGet([
    "collectorEnabled",
    "collectorRunning",
    "activeCollectionJob",
    "collectorTabId"
  ]);
  const enabled = stored.collectorEnabled ?? !!stored.collectorRunning;
  await storageSet({ collectorEnabled: enabled, collectorRunning: false });

  // Migrate the previous single-window state when updating the extension.
  const legacyTabId = stored.activeCollectionJob?.tabId ?? stored.collectorTabId;
  if (stored.activeCollectionJob && legacyTabId !== undefined && legacyTabId !== null) {
    try {
      const tab = await getTab(legacyTabId);
      const job = Object.assign({}, stored.activeCollectionJob, {
        tabId: tab.id,
        windowId: tab.windowId
      });
      await setWindowJob(tab.windowId, job);
    } catch (error) {
      // Its lease will expire and become available to another window.
    }
    await storageSet({ activeCollectionJob: null, collectorTabId: null });
  }

  if (enabled) {
    await claimAllWindows();
  }
})();

setInterval(() => {
  claimAllWindows().catch(() => {});
}, CLAIM_INTERVAL_MS);
