const TRACKER_PIXEL_MARKER = "data-email-tracker-pixel";
const BADGE_REFRESH_MS = 10_000;
const MUTATION_DEBOUNCE_MS = 200;
const MAX_ROWS_TO_RENDER = 120;
const ACCOUNT_EMAIL_SCAN_MS = 15_000;

let inboxBadgeItems = [];
let lastInboxRefreshAt = 0;
let mutationWorkTimer = null;
let isRenderingBadges = false;
let currentThreadUrl = window.location.href;
let cachedLoggedInEmail = "";
const processedSuppressEmailIds = new Set();

init();

function init() {
  injectBadgeStyles();
  attachPageObserver();
  attachThreadNavigationReset();
  attachVisibilityRefresh();
  scanForComposeDialogs();
  refreshInboxBadgeData();
  scanAndMarkSuppressNext();
  setInterval(refreshInboxBadgeData, BADGE_REFRESH_MS);
  setInterval(refreshLoggedInEmailCache, ACCOUNT_EMAIL_SCAN_MS);
}

function attachVisibilityRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshInboxBadgeData();
    }
  });
}

function attachPageObserver() {
  // Gmail is a SPA and re-renders conversation/message DOM fragments frequently.
  // We observe body-level mutations so suppression checks rerun whenever thread content changes.
  if (!(document.body instanceof HTMLElement)) {
    window.requestAnimationFrame(attachPageObserver);
    return;
  }

  const observer = new MutationObserver(() => {
    scheduleMutationWork();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function scheduleMutationWork() {
  // Debouncing avoids expensive rescans during bursty Gmail mutations.
  if (mutationWorkTimer) {
    clearTimeout(mutationWorkTimer);
  }

  mutationWorkTimer = setTimeout(() => {
    mutationWorkTimer = null;
    maybeResetSuppressionStateOnNavigation();
    scanForComposeDialogs();
    renderInboxBadges();
    scanAndMarkSuppressNext();
  }, MUTATION_DEBOUNCE_MS);
}

function attachThreadNavigationReset() {
  const wrapHistoryMethod = (methodName) => {
    const original = history[methodName];
    if (typeof original !== "function") {
      return;
    }

    history[methodName] = function wrappedHistoryMethod(...args) {
      const result = original.apply(this, args);
      maybeResetSuppressionStateOnNavigation();
      scheduleMutationWork();
      return result;
    };
  };

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");

  window.addEventListener("popstate", () => {
    maybeResetSuppressionStateOnNavigation();
    scheduleMutationWork();
  });

  window.addEventListener("hashchange", () => {
    maybeResetSuppressionStateOnNavigation();
    scheduleMutationWork();
  });
}

function maybeResetSuppressionStateOnNavigation() {
  const href = window.location.href;
  if (href === currentThreadUrl) {
    return;
  }

  currentThreadUrl = href;
  processedSuppressEmailIds.clear();
}

function injectBadgeStyles() {
  if (document.getElementById("email-tracker-badge-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "email-tracker-badge-style";
  style.textContent = `
    .et-opens-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 999px;
      width: 24px;
      height: 24px;
      padding: 0;
      margin-left: 6px;
      background: #8b5cf6;
      color: #fff;
      font-size: 14px;
      line-height: 1;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;
      vertical-align: middle;
      position: relative;
      z-index: 5;
      pointer-events: auto;
    }

    .et-opens-badge svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
      pointer-events: none;
    }

    .et-opens-badge.et-disabled {
      opacity: 0.35;
      cursor: default;
    }
    .et-opens-slot {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
  `;

  document.head.appendChild(style);
}

function scanForComposeDialogs() {
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  dialogs.forEach((dialog) => {
    if (dialog instanceof HTMLElement && dialog.dataset.emailTrackerBound !== "1") {
      dialog.dataset.emailTrackerBound = "1";
      bindComposeDialog(dialog);
    }

    injectTrackingPixelIfNeeded(dialog).catch((error) => {
      if (!isContextInvalidatedError(error)) {
        // eslint-disable-next-line no-console
        console.warn("Email tracker inject failed:", error);
      }
    });
  });
}

function bindComposeDialog(dialog) {
  const triggerInjection = () => {
    injectTrackingPixelIfNeeded(dialog).catch((error) => {
      if (!isContextInvalidatedError(error)) {
        // eslint-disable-next-line no-console
        console.warn("Email tracker dialog inject failed:", error);
      }
    });
  };

  dialog.addEventListener(
    "mousedown",
    (event) => {
      if (isSendIntentTarget(event.target)) {
        triggerInjection();
      }
    },
    true
  );

  dialog.addEventListener(
    "click",
    (event) => {
      if (isSendIntentTarget(event.target)) {
        triggerInjection();
      }
    },
    true
  );

  dialog.addEventListener(
    "keydown",
    (event) => {
      const keyboardEvent = event;
      if (!(keyboardEvent instanceof KeyboardEvent)) {
        return;
      }

      const isEnter = keyboardEvent.key === "Enter";
      const hasSendModifier = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
      if (isEnter && hasSendModifier) {
        triggerInjection();
      }
    },
    true
  );

  dialog.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('[aria-label="To"], [name="to"]')) {
        triggerInjection();
      }
    },
    true
  );
}

async function injectTrackingPixelIfNeeded(dialog) {
  if (!isRuntimeAvailable()) {
    return;
  }

  const body = findComposeBody(dialog);
  if (!body) {
    return;
  }

  if (body.querySelector(`img[${TRACKER_PIXEL_MARKER}]`)) {
    return;
  }

  const recipient = getPrimaryRecipient(dialog);
  if (!recipient || recipient === "unknown") {
    return;
  }
  const senderEmail = getSenderEmail(dialog);

  const subject = getSubject(dialog);

  const response = await chrome.runtime.sendMessage({
    type: "tracker:getComposeTrackingData",
    recipient,
    senderEmail
  }).catch((error) => {
    if (!isContextInvalidatedError(error)) {
      // eslint-disable-next-line no-console
      console.warn("Email tracker getComposeTrackingData failed:", error);
    }

    return null;
  });

  if (!response?.ok) {
    return;
  }

  const img = document.createElement("img");
  img.setAttribute(TRACKER_PIXEL_MARKER, "1");
  img.src = response.pixelUrl;
  img.width = 1;
  img.height = 1;
  img.alt = "";
  img.style.cssText = "width:1px;height:1px;opacity:0;display:block;border:0;";

  const compactEmailId = encodeUuidCompact(response.emailId) || response.emailId;

  const marker = document.createElement("div");
  marker.id = `s${compactEmailId}`;
  marker.setAttribute("data-email-tracker-marker", "1");
  marker.setAttribute("data-et", compactEmailId);
  marker.hidden = true;
  marker.textContent = "\u200C";

  body.appendChild(marker);
  body.appendChild(img);

  chrome.runtime.sendMessage({
    type: "tracker:logTrackedEmail",
    payload: {
      emailId: response.emailId,
      recipient: response.recipient,
      senderEmail: response.senderEmail || senderEmail || "",
      subject,
      sentAt: response.sentAt,
      pixelUrl: response.pixelUrl
    }
  }).catch(() => {
    // no-op
  });

  refreshInboxBadgeData();
}

function findComposeBody(dialog) {
  return (
    dialog.querySelector('div[aria-label="Message Body"]') ||
    dialog.querySelector('div[role="textbox"][contenteditable="true"]')
  );
}

function getSubject(dialog) {
  const subjectInput = dialog.querySelector('input[name="subjectbox"], input[aria-label*="Subject"]');
  if (subjectInput instanceof HTMLInputElement) {
    return subjectInput.value.trim();
  }

  return "";
}

function getPrimaryRecipient(dialog) {
  const directSelectors = [
    '[name="to"] [email]',
    '[email][data-hovercard-id]',
    '[email]'
  ];

  const emails = new Set();

  directSelectors.forEach((selector) => {
    dialog.querySelectorAll(selector).forEach((node) => {
      if (!(node instanceof Element)) {
        return;
      }

      const emailAttr = node.getAttribute("email") || "";
      const hovercardAttr = node.getAttribute("data-hovercard-id") || "";
      const candidate = normalizeEmailCandidate(emailAttr || hovercardAttr);
      if (isLikelyEmail(candidate)) {
        emails.add(candidate.toLowerCase());
      }
    });
  });

  const inputSelectors = [
    'input[name="to"]',
    'textarea[name="to"]',
    'div[aria-label="To"] input',
    'div[aria-label="To"] textarea'
  ];

  inputSelectors.forEach((selector) => {
    const node = dialog.querySelector(selector);
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      return;
    }

    const parsed = extractEmailsFromText(node.value || "");
    parsed.forEach((email) => emails.add(email));
  });

  if (emails.size > 0) {
    return Array.from(emails).join(",");
  }

  return "unknown";
}

function getSenderEmail(dialog) {
  const selectors = [
    '[name="from"] [email]',
    '[name="from"] [data-hovercard-id]',
    'input[name="from"]',
    'textarea[name="from"]',
    '[aria-label*="From"] [email]',
    '[aria-label*="From"] [data-hovercard-id]'
  ];

  for (const selector of selectors) {
    const node = dialog.querySelector(selector);
    if (!node) {
      continue;
    }

    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      const parsed = extractEmailsFromText(node.value || "");
      if (parsed.length > 0) {
        return parsed[0];
      }
      continue;
    }

    if (node instanceof Element) {
      const candidate = normalizeEmailCandidate(node.getAttribute("email") || node.getAttribute("data-hovercard-id") || "");
      if (isLikelyEmail(candidate)) {
        return candidate.toLowerCase();
      }
    }
  }

  const accountNode = document.querySelector('a[aria-label*="Google Account"]');
  const accountLabel = accountNode?.getAttribute("aria-label") || "";
  return extractEmailsFromText(accountLabel)[0] || "";
}

async function refreshInboxBadgeData() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "tracker:getInboxBadgeData"
    });

    if (!response?.ok || !Array.isArray(response.items)) {
      return;
    }

    inboxBadgeItems = response.items;
    lastInboxRefreshAt = Date.now();
    renderInboxBadges();
  } catch {
    // no-op
  }
}

function renderInboxBadges() {
  if (isRenderingBadges) {
    return;
  }

  if (Date.now() - lastInboxRefreshAt > BADGE_REFRESH_MS * 2) {
    return;
  }

  const rows = Array.from(document.querySelectorAll("tr.zA")).slice(0, MAX_ROWS_TO_RENDER);

  isRenderingBadges = true;

  try {
    rows.forEach((row) => {
      if (!(row instanceof HTMLElement)) {
        return;
      }

      const matched = findTrackedItemForRow(row);
      const slot = findBadgeSlot(row);
      if (!slot) {
        return;
      }

      slot.classList.add("et-opens-slot");

      let badge = slot.querySelector(".et-opens-badge");
      if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = "et-opens-badge";
        slot.appendChild(badge);
      }

      let isDisabled = false;
      let clickHandler = () => {
        window.location.assign("https://email-tracker.duckdns.org/dashboard");
      };
      let title = "Open dashboard";

      if (matched) {
        const opens = Number(matched.totalOpenEvents || 0);
        title = `Opens: ${opens}`;
        clickHandler = () => {
          const dashboardUrl = `${matched.baseUrl || "https://email-tracker.duckdns.org"}/dashboard?tab=opens&email_id=${encodeURIComponent(
            matched.emailId
          )}`;
          window.location.assign(dashboardUrl);
        };
      }

        const stateKey = `${isDisabled ? "1" : "0"}|${matched?.emailId || "none"}|${title}`;
        if (badge.dataset.stateKey !== stateKey) {
        badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h18v2H3v-2zm2-2l4-5 4 3 5-7 2 1.4-6.2 8.6-4.1-3.1L6.6 16.8 5 15z"/></svg>';
        badge.classList.toggle("et-disabled", isDisabled);
        badge.title = title;
        badge.setAttribute("aria-label", title);
        badge.dataset.stateKey = stateKey;
      }

        badge.disabled = false;
        badge.onmousedown = (event) => {
          event.stopPropagation();
          if (event instanceof MouseEvent) {
            event.preventDefault();
          }
        };
        badge.onclick = (event) => {
          event.stopPropagation();
          if (event instanceof MouseEvent) {
            event.preventDefault();
          }
          if (clickHandler) {
            clickHandler();
          }
        };
    });
  } finally {
    isRenderingBadges = false;
  }
}

function scanAndMarkSuppressNext() {
  if (!isRuntimeAvailable()) {
    return;
  }

  if (!isConversationViewRendered()) {
    return;
  }

  const currentEmail = getCurrentLoggedInEmail();
  if (!isLikelyEmail(currentEmail)) {
    return;
  }

  const images = document.querySelectorAll("img[src]");
  images.forEach((imgNode) => {
    if (!(imgNode instanceof HTMLImageElement)) {
      return;
    }

    const src = imgNode.getAttribute("src") || imgNode.src || "";
    const token = extractTokenFromTrackingSrc(src);
    if (!token) {
      return;
    }

    const payload = decodeTrackingPayloadFromToken(token);
    if (!payload?.emailId || !payload?.senderEmail) {
      return;
    }

    if (processedSuppressEmailIds.has(payload.emailId)) {
      return;
    }

    // Identity-based suppression: sender viewing own tracked message should suppress next open.
    // Folder names are unreliable in Gmail SPA; account identity is stable for this decision.
    if (normalizeEmailCandidate(payload.senderEmail) !== normalizeEmailCandidate(currentEmail)) {
      return;
    }

    processedSuppressEmailIds.add(payload.emailId);
    chrome.runtime
      .sendMessage({
        type: "tracker:markSuppressNext",
        emailId: payload.emailId
      })
      .catch(() => {
        // no-op
      });
  });
}

function isConversationViewRendered() {
  const main = document.querySelector('div[role="main"]');
  if (!(main instanceof HTMLElement)) {
    return false;
  }

  return Boolean(main.querySelector('img[src*="/t/"]') || main.querySelector("[data-message-id], [data-legacy-message-id]"));
}

function refreshLoggedInEmailCache() {
  const latest = detectCurrentLoggedInEmail();
  if (latest) {
    cachedLoggedInEmail = latest;
  }
}

function getCurrentLoggedInEmail() {
  const detected = detectCurrentLoggedInEmail();
  if (detected) {
    cachedLoggedInEmail = detected;
    return detected;
  }

  return cachedLoggedInEmail;
}

function detectCurrentLoggedInEmail() {
  const candidates = [];
  const accountAnchor = document.querySelector('a[aria-label^="Google Account"], a[aria-label*="Google Account"]');

  if (accountAnchor instanceof HTMLElement) {
    candidates.push(accountAnchor.getAttribute("data-email"));
    candidates.push(accountAnchor.getAttribute("aria-label"));
    candidates.push(accountAnchor.getAttribute("title"));
    candidates.push(accountAnchor.textContent);
  }

  const userInfoNode = document.querySelector('[data-email]');
  if (userInfoNode instanceof HTMLElement) {
    candidates.push(userInfoNode.getAttribute("data-email"));
    candidates.push(userInfoNode.getAttribute("aria-label"));
  }

  for (const candidate of candidates) {
    const emails = extractEmailsFromText(candidate || "");
    if (emails.length > 0 && isLikelyEmail(emails[0])) {
      return normalizeEmailCandidate(emails[0]);
    }
  }

  return "";
}

function extractTokenFromTrackingSrc(src) {
  const value = String(src || "");
  const direct = extractTokenFromText(value);
  if (direct) {
    return direct;
  }

  try {
    const url = new URL(value, window.location.origin);
    const possibleParams = ["url", "u", "q", "imgurl"];
    for (const key of possibleParams) {
      const param = url.searchParams.get(key);
      if (!param) {
        continue;
      }

      const decoded = safeDecodeURIComponent(param);
      const hit = extractTokenFromText(decoded) || extractTokenFromText(param);
      if (hit) {
        return hit;
      }
    }

    const decodedHref = safeDecodeURIComponent(url.href);
    const decodedHit = extractTokenFromText(decodedHref);
    if (decodedHit) {
      return decodedHit;
    }
  } catch {
    // no-op
  }

  return "";
}

function extractTokenFromText(input) {
  const text = String(input || "");
  const hit = text.match(/\/t\/([^/?#.]+)\.gif/i);
  return hit?.[1] ? hit[1] : "";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function decodeTrackingPayloadFromToken(token) {
  const raw = String(token || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);

    if (Array.isArray(parsed)) {
      const emailId = String(parsed[1] || "").trim().toLowerCase();
      const senderEmail = normalizeEmailCandidate(parsed[4] || "");
      return emailId ? { emailId, senderEmail } : null;
    }

    if (parsed && typeof parsed === "object") {
      const emailId = String(parsed.email_id || "").trim().toLowerCase();
      const senderEmail = normalizeEmailCandidate(parsed.sender_email || "");
      return emailId ? { emailId, senderEmail } : null;
    }

    return null;
  } catch {
    // Token parse failures are expected on non-tracker images; fail silently.
    return null;
  }
}

function isElementVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return false;
  }

  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

function isMarkerInVisibleMessage(marker) {
  if (!(marker instanceof HTMLElement)) {
    return false;
  }

  const container =
    marker.closest("div.adn") ||
    marker.closest("div[role='listitem']") ||
    marker.closest("div.if") ||
    marker.parentElement;

  return isElementVisible(container);
}

function findBadgeSlot(row) {
  return (
    row.querySelector("span.bog")?.parentElement ||
    row.querySelector("span.y2")?.parentElement ||
    row.querySelector("span[email]")?.parentElement ||
    row.querySelector("td.xY .y6") ||
    row.querySelector("td.xY") ||
    row.querySelector("td.yX") ||
    row.querySelector("td.xW") ||
    row.querySelector("td.xW span")?.parentElement ||
    row.querySelector("td")
  );
}

function findTrackedItemForRow(row) {
  if (!(row instanceof HTMLElement) || !inboxBadgeItems.length) {
    return null;
  }

  const markerEmailId = extractMarkerEmailIdFromRow(row);
  if (markerEmailId) {
    const exact = inboxBadgeItems.find((item) => String(item.emailId || "").toLowerCase() === markerEmailId);

    if (exact) {
      return {
        ...exact,
        baseUrl: exact.pixelUrl ? extractBaseUrl(exact.pixelUrl) : "https://email-tracker.duckdns.org"
      };
    }
  }

  const rowText = row.textContent?.toLowerCase() || "";

  const normalizedRow = normalizeText(rowText);
  let bestMatch = null;
  let bestScore = 0;

  for (const item of inboxBadgeItems) {
    const recipient = normalizeText(String(item.recipient || ""));
    const subject = normalizeText(String(item.subject || ""));
    const recipientParts = recipient
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    const recipientHit = recipientParts.some((part) => {
      const local = part.split("@")[0];
      return normalizedRow.includes(part) || (local && normalizedRow.includes(local));
    });

    const subjectHit = subject ? normalizedRow.includes(subject) : false;
    const subjectTokenHit = !subjectHit && subject ? hasStrongSubjectTokenOverlap(normalizedRow, subject) : false;

    let score = 0;
    if (subjectHit) score += 5;
    if (subjectTokenHit) score += 3;
    if (recipientHit) score += 2;

    if (score === 0) {
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        ...item,
        baseUrl: item.pixelUrl ? extractBaseUrl(item.pixelUrl) : "https://email-tracker.duckdns.org"
      };
    }
  }

  return bestMatch;
}

function extractMarkerEmailIdFromRow(row) {
  const rowHtml = row.innerHTML || "";
  const byCompactDataAttr = rowHtml.match(/data-et=["']([a-z0-9_-]{8,})["']/i);
  if (byCompactDataAttr?.[1]) {
    const decoded = decodeUuidCompact(byCompactDataAttr[1]);
    if (decoded) {
      return decoded;
    }
  }

  const byCompactId = rowHtml.match(/id=["']s([a-z0-9_-]{8,})["']/i);
  if (byCompactId?.[1]) {
    const decoded = decodeUuidCompact(byCompactId[1]);
    if (decoded) {
      return decoded;
    }
  }

  const byDataAttr = rowHtml.match(/data-snv=["']([0-9a-f-]{36})["']/i);
  if (byDataAttr?.[1]) {
    return byDataAttr[1].toLowerCase();
  }

  const byId = rowHtml.match(/snvTrackDiv-([0-9a-f-]{36})/i);
  if (byId?.[1]) {
    return byId[1].toLowerCase();
  }

  const byText = row.textContent?.match(/snv:([0-9a-f-]{36})/i);
  return byText?.[1]?.toLowerCase() || null;
}

function extractEmailsFromText(value) {
  const matches = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return matches.map((email) => email.toLowerCase());
}

function encodeUuidCompact(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    return "";
  }

  const hex = normalized.replace(/-/g, "");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeUuidCompact(value) {
  const compact = String(value || "").trim();
  if (!compact) {
    return "";
  }

  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    if (binary.length !== 16) {
      return "";
    }

    let hex = "";
    for (let i = 0; i < binary.length; i += 1) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
    }

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return "";
  }
}

function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(normalizeEmailCandidate(value));
}

function normalizeEmailCandidate(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/[<>"']/g, "")
    .split(/[\s,;]+/)[0] || "";

  return normalized.toLowerCase();
}

function isSendIntentTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  const button = target.closest('div[role="button"],button');
  if (!button) {
    return false;
  }

  const label = [
    button.getAttribute("data-tooltip"),
    button.getAttribute("aria-label"),
    button.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return label.includes("send") || button.getAttribute("data-tooltip-id") === "tt-c";
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasStrongSubjectTokenOverlap(rowText, subject) {
  const subjectTokens = subject.split(/[^a-z0-9]+/i).filter((token) => token.length >= 4);
  if (!subjectTokens.length) {
    return false;
  }

  let hits = 0;
  for (const token of subjectTokens) {
    if (rowText.includes(token)) {
      hits += 1;
    }
  }

  return hits >= Math.min(2, subjectTokens.length);
}

function extractBaseUrl(pixelUrl) {
  try {
    const url = new URL(pixelUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://email-tracker.duckdns.org";
  }
}

function isRuntimeAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

function isContextInvalidatedError(error) {
  const message = String(error?.message || error || "");
  return message.toLowerCase().includes("extension context invalidated");
}
