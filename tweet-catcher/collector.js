// Persist posts throughout the scroll instead of holding a full timeline in memory.
const BATCH_SIZE = 5;
const SCAN_DELAY_MS = 1800;
const MAX_EMPTY_SCANS = 8;
const MAX_LOADING_WAITS = 12;
const SAME_TWEET_SCANS = 3;
const HEARTBEAT_MS = 3 * 60 * 1000;
const PENDING_PREVIEW_LIMIT = 40;

let collecting = false;
let stopping = false;
let currentJob = null;
let pendingPosts = [];
let seenPostIds = new Set();
let skippedPostIds = new Set();
let unresolvedAttempts = new Map();
let heartbeatTimer = null;
let timelineObserver = null;
let watchScheduled = false;
let reportedPendingKey = "";

function sendCollectorMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "The collector extension did not respond."));
        return;
      }
      resolve(response);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMetric(element) {
  if (!element) {
    return null;
  }

  const value = String(element.getAttribute("aria-label") || element.textContent || "")
    .trim()
    .replace(/,/g, "");
  const match = value.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!match) {
    return null;
  }

  const multipliers = { K: 1e3, M: 1e6, B: 1e9 };
  const multiplier = multipliers[(match[2] || "").toUpperCase()] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

function statusDetails(tweet) {
  const time = tweet.querySelector("time");
  const anchor = time?.closest('a[href*="/status/"]')
    || tweet.querySelector('a[href*="/status/"]');
  const href = anchor?.getAttribute("href") || "";
  const match = href.match(/^\/([^/]+)\/status\/([0-9]+)/);
  if (!match) {
    return null;
  }

  return {
    handle: match[1],
    externalId: match[2],
    sourceUrl: `https://x.com/${match[1]}/status/${match[2]}`,
    publishedAt: time?.getAttribute("datetime") || null
  };
}

function detectPostType(tweet) {
  const text = tweet.innerText || "";
  if (/\bReposted\b/i.test(text)) {
    return "repost";
  }
  if (/Replying to/i.test(text)) {
    return "reply";
  }
  if (tweet.querySelectorAll('[data-testid="tweet"]').length > 0) {
    return "quote";
  }
  return "post";
}

function extractVisiblePosts() {
  if (!currentJob?.profile?.xHandle) {
    return [];
  }

  const expectedHandle = currentJob.profile.xHandle.toLowerCase();
  const posts = [];

  document.querySelectorAll('[data-testid="tweet"]').forEach(tweet => {
    if (tweet.parentElement?.closest('[data-testid="tweet"]')) {
      return;
    }

    const details = statusDetails(tweet);
    if (
      !details
      || details.handle.toLowerCase() !== expectedHandle
      || seenPostIds.has(details.externalId)
    ) {
      return;
    }

    const text = tweet.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
    if (!text) {
      return;
    }

    seenPostIds.add(details.externalId);
    posts.push({
      externalId: details.externalId,
      authorHandle: details.handle,
      sourceUrl: details.sourceUrl,
      text,
      publishedAt: details.publishedAt,
      postType: detectPostType(tweet),
      isPinned: /\bPinned\b/i.test(
        tweet.querySelector('[data-testid="socialContext"]')?.textContent || ""
      ),
      numberOfComments: parseMetric(tweet.querySelector('[data-testid="reply"]')),
      numberOfLikes: parseMetric(tweet.querySelector('[data-testid="like"], [data-testid="unlike"]'))
    });
  });

  return posts;
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function timelineRoot() {
  return document.querySelector('[data-testid="primaryColumn"]') || document.body;
}

function topLevelTweets() {
  return Array.from(document.querySelectorAll('[data-testid="tweet"]')).filter(
    tweet => !tweet.parentElement?.closest('[data-testid="tweet"]')
  );
}

function profilePostsAreProtected() {
  if (topLevelTweets().length > 0) {
    return false;
  }

  const text = (timelineRoot().innerText || "").replace(/\s+/g, " ");
  return /\bthese (posts|tweets) are protected\b/i.test(text)
    || /\bprotected posts\b/i.test(text)
    || /\bposts are protected\b/i.test(text);
}

function timelineIsStillLoadingOrFailed() {
  const timeline = timelineRoot();
  const progressbars = Array.from(timeline.querySelectorAll('[role="progressbar"]')).filter(isVisible);
  const loadingMore = progressbars.some(element => element.getBoundingClientRect().top > window.innerHeight * 0.55);
  if (loadingMore || (seenPostIds.size === 0 && progressbars.length > 0)) {
    return true;
  }

  return Array.from(timeline.querySelectorAll('button, [role="button"], [role="alert"]')).some(element =>
    isVisible(element)
    && /\b(retry|try again|something went wrong|rate limit)\b/i.test(element.textContent || "")
  );
}

function continuationButton() {
  return Array.from(timelineRoot().querySelectorAll('button, [role="button"]')).find(element => {
    if (!isVisible(element) || element.closest('[data-testid="tweet"]')) {
      return false;
    }
    return /\b(show more|retry|try again)\b/i.test(element.textContent || "");
  }) || null;
}

function queuePosts(posts) {
  if (!posts.length) {
    return;
  }

  pendingPosts.push(...posts);
}

function visibleTweetKey() {
  const expectedHandle = currentJob?.profile?.xHandle?.toLowerCase();
  if (!expectedHandle) {
    return "";
  }

  const ids = [];
  topLevelTweets().forEach(tweet => {
    const details = statusDetails(tweet);
    if (!details || details.handle.toLowerCase() !== expectedHandle) {
      return;
    }
    ids.push(details.externalId);
  });
  return ids.join(",");
}

function unresolvedVisibleTweet() {
  const expectedHandle = currentJob?.profile?.xHandle?.toLowerCase();
  if (!expectedHandle) {
    return false;
  }

  return topLevelTweets().some(tweet => {
    const details = statusDetails(tweet);
    if (
      !details
      || details.handle.toLowerCase() !== expectedHandle
      || seenPostIds.has(details.externalId)
      || skippedPostIds.has(details.externalId)
    ) {
      return false;
    }

    const text = tweet.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
    if (text) {
      return false;
    }

    const attempts = (unresolvedAttempts.get(details.externalId) || 0) + 1;
    unresolvedAttempts.set(details.externalId, attempts);
    if (attempts >= 3) {
      skippedPostIds.add(details.externalId);
      return false;
    }
    return true;
  });
}

function scrollFurther() {
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
  const target = cells.length ? cells[cells.length - 1] : topLevelTweets().at(-1);
  if (target) {
    target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  }

  const delta = Math.max(window.innerHeight, 700);
  window.scrollBy(0, delta);
  const scrollingElement = document.scrollingElement || document.documentElement;
  scrollingElement.scrollTop += delta;

  let node = target?.parentElement || null;
  while (node && node !== document.documentElement) {
    if (node.scrollHeight > node.clientHeight + 40) {
      node.scrollTop += delta;
    }
    node = node.parentElement;
  }
}

function summarizePost(post) {
  return {
    externalId: post.externalId,
    text: String(post.text || "").replace(/\s+/g, " ").trim().slice(0, 180),
    publishedAt: post.publishedAt || null
  };
}

async function reportPending(force = false) {
  const posts = pendingPosts.slice(0, PENDING_PREVIEW_LIMIT).map(summarizePost);
  const key = `${pendingPosts.length}:${posts.map(post => post.externalId).join(",")}`;
  if (!force && key === reportedPendingKey) {
    return;
  }
  reportedPendingKey = key;
  try {
    await sendCollectorMessage({
      type: "PENDING_POSTS",
      count: pendingPosts.length,
      posts
    });
  } catch (error) {
    // The popup list is informational; collection should continue.
  }
}

function watchTimeline() {
  if (timelineObserver) {
    timelineObserver.disconnect();
  }
  watchScheduled = false;
  timelineObserver = new MutationObserver(() => {
    if (!collecting || watchScheduled) {
      return;
    }
    watchScheduled = true;
    requestAnimationFrame(() => {
      watchScheduled = false;
      if (!collecting) {
        return;
      }
      queuePosts(extractVisiblePosts());
    });
  });
  timelineObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopWatchingTimeline() {
  timelineObserver?.disconnect();
  timelineObserver = null;
  watchScheduled = false;
}

async function flushPosts(force = false) {
  if (!pendingPosts.length || (!force && pendingPosts.length < BATCH_SIZE)) {
    return { stop: false };
  }

  const batch = pendingPosts.splice(0, BATCH_SIZE);
  try {
    const response = await sendCollectorMessage({ type: "UPLOAD_POSTS", posts: batch });
    return response.result || { stop: false };
  } catch (error) {
    pendingPosts.unshift(...batch);
    throw error;
  }
}

async function finishCollection(reason, hasMore = false) {
  if (stopping) {
    return;
  }

  collecting = false;
  clearInterval(heartbeatTimer);

  while (pendingPosts.length) {
    await flushPosts(true);
  }
  await reportPending(true);

  stopping = true;
  try {
    await sendCollectorMessage({
      type: "COMPLETE_COLLECTION",
      reason,
      hasMore
    });
  } catch (error) {
    stopping = false;
    throw error;
  }
}

async function runCollector(job) {
  if (collecting || !job) {
    return;
  }

  collecting = true;
  stopping = false;
  currentJob = job;
  pendingPosts = [];
  seenPostIds = new Set();
  skippedPostIds = new Set();
  unresolvedAttempts = new Map();
  reportedPendingKey = "";
  let emptyScans = 0;
  let loadingWaits = 0;
  let sameTweetScans = 0;
  let lastVisibleKey = "";

  await sendCollectorMessage({ type: "COLLECTION_STARTED" });
  await reportPending(true);
  watchTimeline();

  heartbeatTimer = setInterval(() => {
    sendCollectorMessage({ type: "COLLECTOR_HEARTBEAT" }).catch(() => {});
  }, HEARTBEAT_MS);

  try {
    while (collecting) {
      queuePosts(extractVisiblePosts());
      if (profilePostsAreProtected()) {
        await finishCollection("protected_posts");
        return;
      }

      const waitingForText = unresolvedVisibleTweet();
      const loading = timelineIsStillLoadingOrFailed();
      await reportPending();

      while (collecting && pendingPosts.length > 0) {
        const uploaded = await flushPosts(true);
        await reportPending(true);
        if (uploaded.stop && currentJob.mode === "update") {
          await finishCollection(uploaded.stopReason || "known_collection_boundary");
          return;
        }
      }

      if (!collecting) {
        return;
      }

      if (loading || waitingForText) {
        sameTweetScans = 0;
        loadingWaits++;
        if (loadingWaits >= MAX_LOADING_WAITS) {
          throw new Error(
            seenPostIds.size === 0
              ? "No posts were visible. Check that X is logged in and the profile is public."
              : "The X timeline stopped loading before the bottom. Collection will retry."
          );
        }
        const button = continuationButton();
        if (button) {
          button.click();
        }
        await sleep(SCAN_DELAY_MS);
        continue;
      }

      loadingWaits = 0;

      const visibleKey = visibleTweetKey();
      if (!visibleKey) {
        sameTweetScans = 0;
        lastVisibleKey = "";
        emptyScans++;
        if (emptyScans >= MAX_EMPTY_SCANS) {
          throw new Error("No posts were visible. Check that X is logged in and the profile is public.");
        }
        scrollFurther();
        await sleep(SCAN_DELAY_MS + Math.floor(Math.random() * 700));
        continue;
      }

      emptyScans = 0;
      if (visibleKey === lastVisibleKey) {
        sameTweetScans++;
      } else {
        sameTweetScans = 1;
        lastVisibleKey = visibleKey;
      }

      if (sameTweetScans >= SAME_TWEET_SCANS) {
        // Onboarding ends at the bottom. An update usually ends earlier, when
        // stored posts repeat, and only falls through to here if the timeline ends.
        await finishCollection("timeline_exhausted");
        return;
      }

      const button = continuationButton();
      if (button) {
        button.click();
        sameTweetScans = 0;
        await sleep(SCAN_DELAY_MS);
        continue;
      }

      scrollFurther();
      await sleep(SCAN_DELAY_MS + Math.floor(Math.random() * 700));
    }
  } catch (error) {
    collecting = false;
    clearInterval(heartbeatTimer);
    if (!stopping) {
      await reportPending(true).catch(() => {});
      await sendCollectorMessage({
        type: "FAIL_COLLECTION",
        message: error.message,
        recoverable: true
      }).catch(() => {});
    }
  } finally {
    stopWatchingTimeline();
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "STOP_COLLECTION") {
    collecting = false;
    stopping = true;
    clearInterval(heartbeatTimer);
  }
});

(async function connectToCollector() {
  try {
    const response = await sendCollectorMessage({ type: "COLLECTOR_READY" });
    if (response.job) {
      await runCollector(response.job);
    }
  } catch (error) {
    console.warn("Tweet Catcher could not connect to the collector:", error);
  }
})();
