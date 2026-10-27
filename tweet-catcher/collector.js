// Persist posts throughout the scroll instead of holding a full timeline in memory.
const BATCH_SIZE = 5;
const SCAN_DELAY_MS = 1800;
const MAX_EMPTY_SCANS = 8;
const MAX_LOADING_WAITS = 12;
const SAME_TWEET_SCANS = 4;
const MAX_UNSETTLED_KICKS = 20;
const MAX_EXPAND_ATTEMPTS = 3;
const EXPAND_WAIT_MS = 1500;
const HEARTBEAT_MS = 3 * 60 * 1000;
const PENDING_PREVIEW_LIMIT = 40;

let collecting = false;
let stopping = false;
let accountMissingFinishStarted = false;
let currentJob = null;
let pendingPosts = [];
let seenPostIds = new Set();
let skippedPostIds = new Set();
let unresolvedAttempts = new Map();
let expandAttempts = new Map();
let expandingPostIds = new Set();
let heartbeatTimer = null;
let timelineObserver = null;
let watchScheduled = false;
let reportedPendingKey = "";
let timelineScrollerNode = null;
let rejectedScrollers = new Set();
let lastScrollMoved = true;

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

function extractVisiblePosts(tweets = null, keepTruncated = false) {
  if (!currentJob?.profile?.xHandle) {
    return [];
  }

  const expectedHandle = currentJob.profile.xHandle.toLowerCase();
  const posts = [];

  (tweets || topLevelTweets()).forEach(tweet => {
    const details = statusDetails(tweet);
    if (
      !details
      || details.handle.toLowerCase() !== expectedHandle
      || seenPostIds.has(details.externalId)
    ) {
      return;
    }

    // The timeline omits the rest of a long post until Show more is opened.
    // A post that is leaving the DOM is saved as shown, so virtualization
    // cannot drop it before the profile is marked done.
    if (
      !keepTruncated
      && (
        expandingPostIds.has(details.externalId)
        || (
          tweetShowMoreLink(tweet)
          && (expandAttempts.get(details.externalId) || 0) < MAX_EXPAND_ATTEMPTS
        )
      )
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
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.top < window.innerHeight;
}

function timelineRoot() {
  return document.querySelector('[data-testid="primaryColumn"]') || document.body;
}

function topLevelTweets(root = document) {
  const matchesRoot = root.nodeType === 1 && root.matches?.('[data-testid="tweet"]');
  const nodes = matchesRoot
    ? [root, ...root.querySelectorAll('[data-testid="tweet"]')]
    : Array.from(root.querySelectorAll?.('[data-testid="tweet"]') || []);
  return nodes.filter(tweet => !tweet.parentElement?.closest('[data-testid="tweet"]'));
}

function profilePostsAreProtected() {
  if (topLevelTweets().length > 0) {
    return false;
  }

  const text = (timelineRoot().innerText || "").replace(/\s+/g, " ");
  return /\bthese (posts|tweets) are protected\b/i.test(text)
    || /\bprotected posts\b/i.test(text)
    || /\bposts are protected\b/i.test(text)
    || /diese (posts|tweets) sind geschützt/iu.test(text);
}

// The profile title under the display name, e.g. "0 posts" or "8,563 posts".
// It comes from the account's post count, not from the timeline cells.
function profileHeaderSaysNoPosts() {
  const root = timelineRoot();
  const nodes = root.querySelectorAll("div, span");
  for (const node of nodes) {
    if (node.childElementCount > 0) {
      continue;
    }
    // Suggested accounts and bios can mention posting. The count sits in the
    // title bar, above the Posts timeline.
    if (node.closest("[aria-label^='Timeline:'], [data-testid='tweet'], [data-testid='UserCell'], [data-testid='UserDescription']")) {
      continue;
    }
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (/^0\s+(posts?|tweets?|beiträge)$/iu.test(text)) {
      return true;
    }
  }
  return false;
}

function postsTabIsSelected() {
  const tab = timelineRoot().querySelector("[role='tab'][aria-selected='true']");
  if (!tab) {
    return false;
  }
  const href = tab.getAttribute("href") || "";
  if (/^\/[A-Za-z0-9_]{1,15}\/?$/.test(href)) {
    return true;
  }
  const label = (tab.textContent || "").replace(/\s+/g, " ").trim();
  return /^(posts|beiträge)$/iu.test(label);
}

// A profile with nothing on the Posts tab. X used to replace the timeline
// with "hasn't posted". A logged-in empty profile now keeps the title
// "0 posts" and fills the timeline with Who to follow, so there is still
// no bottom to scroll to and no spinner that ends. Missing that and failing
// the job releases the lease, and the claim loop reloads the same profile.
function profileHasNoPosts() {
  if (topLevelTweets().length > 0 || seenPostIds.size > 0) {
    return false;
  }

  const root = timelineRoot();
  const empty = root.querySelector(
    '[data-testid="emptyState"], [data-testid="empty_state_header_text"], [data-testid="empty_state_body_text"]'
  );
  const source = empty && isVisible(empty) ? empty : root;
  const text = (source.innerText || "").replace(/\s+/g, " ");
  const header = /hasn['’]t posted|haven['’]t posted|has not posted|have not posted|hat noch nicht gepostet|hat noch nichts gepostet|haben noch nicht gepostet|hast noch nicht gepostet/iu.test(text);
  const body = /posts will show up here|werden (die )?posts hier angezeigt|sobald es soweit ist/iu.test(text);
  if (empty && isVisible(empty)) {
    return header || body;
  }
  if (header && body) {
    return true;
  }

  // The title count is already zero, and the Posts tab is the one on screen.
  // Waiting for tweets here only scrolls, fails the lease, and reloads.
  return profileHeaderSaysNoPosts()
    && postsTabIsSelected()
    && !!root.querySelector("[data-testid='UserName']");
}

// The English profile heading is "This account doesn’t exist" (U+2019). A
// soft navigation keeps posts from the previous profile in memory, and that
// must not hide this heading or the claim loop reloads the same page.
function textSaysAccountDoesNotExist(value) {
  const text = String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02BB\u00B4\uFF07\u0092']/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return text.includes("this account doesnt exist")
    || text.includes("this account does not exist")
    || text.includes("dieses konto existiert nicht")
    || text.includes("dieser account existiert nicht");
}

function profileAccountDoesNotExist() {
  const headings = document.querySelectorAll('[data-testid="empty_state_header_text"]');
  for (const heading of headings) {
    if (
      textSaysAccountDoesNotExist(heading.textContent)
      || textSaysAccountDoesNotExist(heading.innerText)
    ) {
      return true;
    }
  }

  if (seenPostIds.size > 0) {
    return false;
  }

  const root = timelineRoot();
  if (topLevelTweets(root).length > 0) {
    return false;
  }
  return textSaysAccountDoesNotExist(root.textContent)
    || textSaysAccountDoesNotExist(root.innerText);
}

function timelineIsLoadingMore() {
  const progressbars = Array.from(timelineRoot().querySelectorAll('[role="progressbar"]')).filter(isVisible);
  return progressbars.some(element => element.getBoundingClientRect().top > window.innerHeight * 0.55)
    || (seenPostIds.size === 0 && progressbars.length > 0);
}

function timelineIsBlocked() {
  return Array.from(timelineRoot().querySelectorAll('button, [role="button"], [role="alert"]')).some(element => {
    if (!isVisible(element)) {
      return false;
    }
    const label = (element.getAttribute("aria-label") || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return /\b(retry|try again|something went wrong|rate limit|erneut versuchen)\b/i.test(label);
  });
}

function continuationButton() {
  return Array.from(timelineRoot().querySelectorAll('button, [role="button"]')).find(element => {
    if (
      !isVisible(element)
      || element.closest("a[href], [data-testid='tweet'], [data-testid='UserDescription'], [data-testid='UserProfileHeader'], [data-testid='UserName']")
    ) {
      return false;
    }
    const label = (element.getAttribute("aria-label") || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    // Match the control itself. A wrapper's text includes every "Show more" on screen,
    // and clicking that wrapper can navigate away before the profile is finalized.
    return /^(show more|mehr anzeigen|retry|try again|erneut versuchen)$/i.test(label);
  }) || null;
}

function controlLabel(element) {
  return (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function tweetShowMoreLink(tweet) {
  return Array.from(tweet.querySelectorAll(
    '[data-testid="tweet-text-show-more-link"], button, [role="button"], a'
  )).find(element => {
    if (element.closest('[data-testid="tweet"]') !== tweet) {
      return false;
    }
    // The control's own label only. A wrapper's text includes the post, and
    // clicking that wrapper opens the permalink instead of expanding the post.
    return /^(show more|mehr anzeigen)$/i.test(controlLabel(element));
  }) || null;
}

function tweetsStillNeedExpansion() {
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
      || !tweetShowMoreLink(tweet)
    ) {
      return false;
    }
    return (expandAttempts.get(details.externalId) || 0) < MAX_EXPAND_ATTEMPTS;
  });
}

function activateShowMore(showMore) {
  const rect = showMore.getBoundingClientRect();
  const offScreen = rect.height > 0 && (rect.bottom <= 0 || rect.top >= window.innerHeight);
  if (offScreen) {
    // scrollIntoView picks the nearest overflow box. After Show more, that box
    // is the expanded post, so the timeline itself never advances.
    const delta = rect.top - Math.round(window.innerHeight * 0.4);
    const scroller = chooseScroller();
    if (isDocumentScroller(scroller)) {
      window.scrollBy(0, delta);
    } else {
      scroller.scrollTop += delta;
    }
  }

  // Show more is often a link to the status page. Expanding it must not navigate,
  // or the content script restarts and the profile is loaded again from the top.
  const href = showMore.tagName === "A" ? showMore.getAttribute("href") : null;
  if (href) {
    showMore.removeAttribute("href");
  }
  const preventNavigation = event => event.preventDefault();
  showMore.addEventListener("click", preventNavigation, true);
  try {
    showMore.click();
  } finally {
    showMore.removeEventListener("click", preventNavigation, true);
    if (href) {
      showMore.setAttribute("href", href);
    }
  }
}

// Long posts only render a preview until this control is opened.
async function expandTruncatedTweets() {
  const expectedHandle = currentJob?.profile?.xHandle?.toLowerCase();
  if (!expectedHandle) {
    return false;
  }

  const pending = [];
  topLevelTweets().forEach(tweet => {
    const details = statusDetails(tweet);
    const showMore = details && tweetShowMoreLink(tweet);
    if (
      !details
      || details.handle.toLowerCase() !== expectedHandle
      || !showMore
      || seenPostIds.has(details.externalId)
      || skippedPostIds.has(details.externalId)
    ) {
      return;
    }

    const attempts = expandAttempts.get(details.externalId) || 0;
    if (attempts >= MAX_EXPAND_ATTEMPTS) {
      return;
    }

    pending.push({
      id: details.externalId,
      showMore
    });
  });

  for (const { id, showMore } of pending) {
    if (!collecting) {
      break;
    }

    expandAttempts.set(id, (expandAttempts.get(id) || 0) + 1);
    expandingPostIds.add(id);
    activateShowMore(showMore);
    // The expanded text arrives after the click, so wait before reading this post
    // or moving on to the next one.
    await sleep(EXPAND_WAIT_MS);
    expandingPostIds.delete(id);
  }

  return tweetsStillNeedExpansion();
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

const BOTTOM_SLOP = 80;

function markerCell() {
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
  return (cells.length ? cells[cells.length - 1] : topLevelTweets().at(-1)) || null;
}

function distanceFromBottom(node) {
  if (!node) {
    return 0;
  }
  return node.scrollHeight - node.clientHeight - node.scrollTop;
}

function isDocumentScroller(node) {
  return !!node && node === (document.scrollingElement || document.documentElement);
}

// A clipped, expanded post can overflow a box taller than the loaded timeline.
// That box is not the feed. Only a scroller that contains the timeline cells,
// or the document itself, can tell us whether the profile has more posts.
function timelineScrollerCandidates() {
  const candidates = [];
  const seen = new Set();
  const add = node => {
    if (!node || seen.has(node) || rejectedScrollers.has(node) || node.nodeType !== 1) {
      return;
    }
    seen.add(node);
    if (node.closest("[data-testid='tweet'], [data-testid='cellInnerDiv']")) {
      return;
    }
    // body and documentElement both report the page height, but only the
    // scrolling element moves. The other one always looks like it has room.
    if ((node === document.body || node === document.documentElement) && !isDocumentScroller(node)) {
      return;
    }
    const isDocument = isDocumentScroller(node);
    if (!isDocument && node.querySelectorAll('[data-testid="cellInnerDiv"]').length < 2) {
      return;
    }
    if (node.scrollHeight <= node.clientHeight + 40) {
      return;
    }
    if (!isDocument) {
      const overflowY = window.getComputedStyle(node).overflowY;
      // overflow:hidden is included because X's timeline scroller uses it.
      // A clipped post uses it too, but that box sits inside one cell and was
      // already excluded above.
      if (
        overflowY !== "auto"
        && overflowY !== "scroll"
        && overflowY !== "overlay"
        && overflowY !== "hidden"
      ) {
        return;
      }
    }
    candidates.push(node);
  };

  let node = markerCell()?.parentElement || timelineRoot();
  while (node) {
    add(node);
    node = node.parentElement;
  }
  add(document.scrollingElement);
  add(document.documentElement);
  add(document.body);
  return candidates;
}

function timelineHasRoom() {
  return timelineScrollerCandidates().some(node => distanceFromBottom(node) > BOTTOM_SLOP);
}

function chooseScroller() {
  const candidates = timelineScrollerCandidates();
  if (
    timelineScrollerNode?.isConnected
    && candidates.includes(timelineScrollerNode)
    && distanceFromBottom(timelineScrollerNode) > BOTTOM_SLOP
  ) {
    return timelineScrollerNode;
  }

  let best = null;
  let bestRoom = -1;
  for (const node of candidates) {
    const room = distanceFromBottom(node);
    if (room > bestRoom) {
      best = node;
      bestRoom = room;
    }
  }

  timelineScrollerNode = best || document.scrollingElement || document.documentElement;
  return timelineScrollerNode;
}

function nudgeScroller(node, delta) {
  if (!node) {
    return false;
  }
  const before = node.scrollTop;
  const room = distanceFromBottom(node);
  if (room <= 1) {
    return false;
  }
  // Land on the edge when close. Stopping short never trips X's loader, so the
  // current slice looks like the end of the profile.
  const step = room <= BOTTOM_SLOP ? room : Math.min(delta, room);
  node.scrollTop = before + step;
  return node.scrollTop > before + 1;
}

function cellOffset() {
  const cell = markerCell();
  if (!cell) {
    return null;
  }
  return cell.getBoundingClientRect().top;
}

function pageIsVisible() {
  return document.visibilityState === "visible";
}

// The lowest rendered timeline row. DOM order is not visual order: X positions
// recycled rows with transforms, and empty spacers sit at the end of the list.
function lowestTimelineCell() {
  let best = null;
  let bestBottom = -Infinity;
  document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach(cell => {
    const rect = cell.getBoundingClientRect();
    if (rect.height < 24 || rect.bottom <= 0) {
      return;
    }
    if (rect.bottom > bestBottom) {
      best = cell;
      bestBottom = rect.bottom;
    }
  });
  return best;
}

// X pins scrollTop to the current scroll height while it is still fetching.
// For that moment the scrollbar is at the end, but the last rendered row sits
// in the middle of the window with an empty gap under it. That gap is more
// timeline, not the end of the profile. The tail is real only when the lowest
// row rests on the bottom edge, or the whole profile fits without scrolling.
function tailReachesWindowBottom() {
  if (!pageIsVisible()) {
    return false;
  }
  const cell = lowestTimelineCell();
  if (!cell || cell.querySelector('[role="progressbar"]')) {
    return false;
  }
  const rect = cell.getBoundingClientRect();
  if (rect.top >= window.innerHeight) {
    return false;
  }
  if (windowHasRoom() || timelineHasRoom()) {
    return false;
  }

  const doc = document.scrollingElement || document.documentElement;
  const scrolled = doc.scrollTop > BOTTOM_SLOP || window.scrollY > BOTTOM_SLOP;
  if (!scrolled) {
    return rect.bottom > 0;
  }

  const band = Math.max(160, Math.round(window.innerHeight * 0.22));
  return rect.bottom >= window.innerHeight - band
    && rect.bottom <= window.innerHeight + BOTTOM_SLOP;
}

function windowHasRoom() {
  const doc = document.scrollingElement || document.documentElement;
  return distanceFromBottom(doc) > BOTTOM_SLOP;
}

function scrollFurther() {
  // Step most of a viewport and leave the previous rows on screen.
  // scrollIntoView on the last cell jumps X's virtual timeline and it reloads.
  const delta = Math.round(Math.max(window.innerHeight * 0.72, 480));
  const before = cellOffset();
  const scroller = chooseScroller();
  const roomBefore = distanceFromBottom(scroller);
  const moved = nudgeScroller(scroller, delta);
  if (!moved && roomBefore > BOTTOM_SLOP) {
    rejectedScrollers.add(scroller);
    timelineScrollerNode = null;
  }
  const doc = document.scrollingElement || document.documentElement;
  const docMoved = doc !== scroller && nudgeScroller(doc, delta);
  let windowMoved = false;
  const afterNudge = cellOffset();
  const cellsMoved = before !== null && afterNudge !== null && afterNudge < before - 1;
  // X loads the next page from the window scroll position. A nested box can
  // report that it moved while the timeline on screen stays on the first posts.
  if (!cellsMoved && (windowHasRoom() || !moved)) {
    const scrollBefore = window.scrollY;
    window.scrollBy(0, delta);
    windowMoved = window.scrollY > scrollBefore + 1;
  }
  const after = cellOffset();
  const timelineMoved = before !== null && after !== null && after < before - 1;
  lastScrollMoved = timelineMoved || moved || docMoved || windowMoved;
}

function pinToEnd() {
  const doc = document.scrollingElement || document.documentElement;
  const scroller = chooseScroller();
  if (scroller && scroller !== doc) {
    scroller.scrollTop = scroller.scrollHeight;
  }
  const top = Math.max(doc.scrollHeight, scroller?.scrollHeight || 0);
  doc.scrollTop = top;
  window.scrollTo(0, top);
}

// Move off the end and pin back to it. A scrollTop that is already at the
// maximum does not ask X for the next page, and the list then grows only
// after another scroll gesture.
async function kickTimeline() {
  const delta = Math.round(Math.max(window.innerHeight * 0.9, 560));
  const doc = document.scrollingElement || document.documentElement;
  const scroller = chooseScroller();
  const nudgeUp = node => {
    if (!node) {
      return;
    }
    node.scrollTop = Math.max(0, node.scrollTop - delta);
  };
  nudgeUp(scroller);
  if (doc !== scroller) {
    nudgeUp(doc);
  }
  window.scrollBy(0, -delta);
  await sleep(450);
  pinToEnd();
  await sleep(SCAN_DELAY_MS);
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
  timelineObserver = new MutationObserver(mutations => {
    if (!collecting) {
      return;
    }
    const removed = [];
    mutations.forEach(mutation => {
      mutation.removedNodes.forEach(node => {
        if (node.nodeType !== 1) {
          return;
        }
        removed.push(...topLevelTweets(node));
      });
    });
    if (removed.length) {
      queuePosts(extractVisiblePosts(removed, true));
    }
    if (watchScheduled) {
      return;
    }
    watchScheduled = true;
    requestAnimationFrame(() => {
      watchScheduled = false;
      if (!collecting) {
        return;
      }
      queuePosts(extractVisiblePosts());
      finishIfAccountMissing();
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

function finishIfAccountMissing() {
  if (accountMissingFinishStarted || stopping || !collecting || !profileAccountDoesNotExist()) {
    return;
  }
  accountMissingFinishStarted = true;
  finishCollection("account_missing").catch(error => {
    accountMissingFinishStarted = false;
    collecting = false;
    clearInterval(heartbeatTimer);
    if (!stopping) {
      sendCollectorMessage({
        type: "FAIL_COLLECTION",
        message: error.message,
        recoverable: true
      }).catch(() => {});
    }
  });
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

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendCollectorMessage({
        type: "COMPLETE_COLLECTION",
        reason,
        hasMore
      });
      stopping = true;
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function runCollector(job) {
  if (collecting || !job) {
    return;
  }

  collecting = true;
  stopping = false;
  accountMissingFinishStarted = false;
  currentJob = job;
  pendingPosts = [];
  seenPostIds = new Set();
  skippedPostIds = new Set();
  unresolvedAttempts = new Map();
  expandAttempts = new Map();
  expandingPostIds = new Set();
  reportedPendingKey = "";
  timelineScrollerNode = null;
  rejectedScrollers = new Set();
  lastScrollMoved = true;
  let emptyScans = 0;
  let loadingWaits = 0;
  let sameTweetScans = 0;
  let unsettledKicks = 0;
  let lastVisibleKey = "";
  let lastScrollHeight = 0;

  await sendCollectorMessage({ type: "COLLECTION_STARTED" });
  await reportPending(true);
  watchTimeline();

  heartbeatTimer = setInterval(() => {
    sendCollectorMessage({ type: "COLLECTOR_HEARTBEAT" }).catch(() => {});
  }, HEARTBEAT_MS);

  try {
    while (collecting) {
      if (profileAccountDoesNotExist()) {
        accountMissingFinishStarted = true;
        await finishCollection("account_missing");
        return;
      }
      const waitingForExpansion = await expandTruncatedTweets();
      queuePosts(extractVisiblePosts());
      if (profileAccountDoesNotExist()) {
        accountMissingFinishStarted = true;
        await finishCollection("account_missing");
        return;
      }
      if (profilePostsAreProtected()) {
        await finishCollection("protected_posts");
        return;
      }
      if (profileHasNoPosts()) {
        await finishCollection("no_posts");
        return;
      }

      // Nothing has rendered yet. Scrolling or kicking this page makes X reload
      // a missing account ("This account doesn’t exist") before the next scan
      // can mark it done. Wait for that heading, or for the first posts.
      if (seenPostIds.size === 0 && topLevelTweets(timelineRoot()).length === 0) {
        const emptyState = timelineRoot().querySelector(
          '[data-testid="emptyState"], [data-testid="empty_state_header_text"]'
        );
        if (emptyState || emptyScans < 3) {
          emptyScans++;
          const stillLoading = timelineIsLoadingMore();
          if (
            (!stillLoading && emptyScans >= MAX_EMPTY_SCANS)
            || emptyScans >= MAX_EMPTY_SCANS + MAX_LOADING_WAITS
          ) {
            throw new Error("No posts were visible. Check that X is logged in and the profile is public.");
          }
          await sleep(SCAN_DELAY_MS);
          continue;
        }
      }

      const waitingForText = unresolvedVisibleTweet();
      const loading = timelineIsLoadingMore();
      const blocked = timelineIsBlocked();
      await reportPending();

      while (collecting && pendingPosts.length > 0) {
        await flushPosts(true);
        await reportPending(true);
      }

      if (!collecting) {
        return;
      }

      // A covered or backgrounded window does not load the next page. Deciding
      // the profile is finished from that frozen first screen leaves the rest
      // of the timeline uncollected.
      if (!pageIsVisible()) {
        sameTweetScans = 0;
        unsettledKicks = 0;
        await sleep(SCAN_DELAY_MS);
        continue;
      }

      const visibleKey = visibleTweetKey();
      const scroller = chooseScroller();
      const doc = document.scrollingElement || document.documentElement;
      const timelineHeight = Math.max(scroller.scrollHeight, doc.scrollHeight);
      const grew = timelineHeight > lastScrollHeight + 40;
      // Scroll height can already be maxed while X is still appending posts.
      // The lowest rendered row has to sit on the bottom edge of the window.
      const atBottom = tailReachesWindowBottom();
      const pinnedToEnd = !windowHasRoom() && !timelineHasRoom();
      if (grew) {
        lastScrollHeight = timelineHeight;
        unsettledKicks = 0;
      }

      if (!visibleKey) {
        sameTweetScans = 0;
        lastVisibleKey = "";
        emptyScans++;
        // A blank gap while posts are already saved is the virtualizer catching
        // up. Failing here releases the lease and reloads the profile.
        if (emptyScans >= MAX_EMPTY_SCANS && seenPostIds.size === 0 && !loading) {
          throw new Error("No posts were visible. Check that X is logged in and the profile is public.");
        }
        if (pinnedToEnd) {
          await kickTimeline();
        } else {
          scrollFurther();
          await sleep(SCAN_DELAY_MS + Math.floor(Math.random() * 700));
        }
        continue;
      }

      emptyScans = 0;
      const keyChanged = visibleKey !== lastVisibleKey;
      if (grew || keyChanged || !atBottom) {
        lastVisibleKey = visibleKey;
        sameTweetScans = 0;
        if (grew || keyChanged) {
          loadingWaits = 0;
        }
      }

      if (loading || blocked || waitingForText || waitingForExpansion) {
        const button = continuationButton();
        if (button) {
          button.click();
        }
        loadingWaits++;
        // A spinner, a blocked timeline, or a post that is still expanding is
        // not the end of the feed. Give the loader time, then retry the job
        // instead of marking the profile fully scraped.
        if (waitingForText || waitingForExpansion || !atBottom || loadingWaits < MAX_LOADING_WAITS) {
          if (!waitingForText && !waitingForExpansion) {
            if (pinnedToEnd) {
              await kickTimeline();
            } else {
              scrollFurther();
              await sleep(SCAN_DELAY_MS);
            }
          } else {
            await sleep(SCAN_DELAY_MS);
          }
          continue;
        }
        throw new Error(
          seenPostIds.size === 0
            ? "No posts were visible. Check that X is logged in and the profile is public."
            : "The X timeline stopped loading before the bottom. Collection will retry."
        );
      }

      if (!atBottom || lastScrollMoved) {
        if (lastScrollMoved || grew) {
          sameTweetScans = 0;
        }
        // Pinned to the current scroll height, but the last row is not on the
        // bottom edge. Another page is still loading. Scrolling further is a
        // no-op here, so step away from the end and pin back onto it.
        if (pinnedToEnd && !lastScrollMoved) {
          if (!grew) {
            unsettledKicks++;
            if (unsettledKicks >= MAX_UNSETTLED_KICKS) {
              throw new Error("The X timeline stopped loading before the bottom. Collection will retry.");
            }
          }
          await kickTimeline();
          continue;
        }
        if (!pinnedToEnd) {
          unsettledKicks = 0;
        }
        scrollFurther();
        await sleep(SCAN_DELAY_MS + Math.floor(Math.random() * 700));
        continue;
      }

      loadingWaits = 0;
      unsettledKicks = 0;
      sameTweetScans++;
      if (sameTweetScans >= SAME_TWEET_SCANS && !grew && !lastScrollMoved && atBottom) {
        let heightBeforeKick = timelineHeight;
        let stillAtEnd = true;
        for (let attempt = 0; attempt < 2 && stillAtEnd && collecting; attempt++) {
          const seenBeforeKick = seenPostIds.size;
          await kickTimeline();
          queuePosts(extractVisiblePosts());
          const heightAfterKick = Math.max(
            chooseScroller().scrollHeight,
            (document.scrollingElement || document.documentElement).scrollHeight
          );
          if (
            seenPostIds.size > seenBeforeKick
            || heightAfterKick > heightBeforeKick + 40
            || windowHasRoom()
            || timelineHasRoom()
            || timelineIsLoadingMore()
            || timelineIsBlocked()
            || !tailReachesWindowBottom()
          ) {
            stillAtEnd = false;
            lastScrollHeight = heightAfterKick;
          }
          heightBeforeKick = heightAfterKick;
        }
        if (!stillAtEnd || !collecting) {
          sameTweetScans = 0;
          scrollFurther();
          await sleep(SCAN_DELAY_MS);
          continue;
        }
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
