const TRACKER_PIXEL_MARKER = "data-email-tracker-pixel";
const BADGE_REFRESH_MS = 10_000;
const MUTATION_DEBOUNCE_MS = 250;
const MAX_ROWS_TO_RENDER = 120;

let inboxBadgeItems = [];
let lastInboxRefreshAt = 0;
let mutationWorkTimer = null;
let isRenderingBadges = false;

init();

function init() {
  injectBadgeStyles();
  attachPageObserver();
  attachVisibilityRefresh();
  scanForComposeDialogs();
  refreshInboxBadgeData();
  setInterval(refreshInboxBadgeData, BADGE_REFRESH_MS);
}

function attachVisibilityRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshInboxBadgeData();
    }
  });
}

function attachPageObserver() {
  const observer = new MutationObserver(() => {
    scheduleMutationWork();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scheduleMutationWork() {
  if (mutationWorkTimer) {
    clearTimeout(mutationWorkTimer);
  }

  mutationWorkTimer = setTimeout(() => {
    mutationWorkTimer = null;
    scanForComposeDialogs();
    renderInboxBadges();
  }, MUTATION_DEBOUNCE_MS);
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

  const marker = document.createElement("div");
  marker.id = `snvTrackDiv-${response.emailId}`;
  marker.setAttribute("data-email-tracker-marker", "1");
  marker.dataset.snv = response.emailId;
  marker.style.cssText = "display:block;width:0;height:0;max-height:0;overflow:hidden;opacity:0;font-size:0;line-height:0;";
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

      let isDisabled = true;
      let clickHandler = null;
      let title = "Open dashboard";

      if (matched) {
        const opens = Number(matched.totalOpenEvents || 0);
        isDisabled = false;
        title = `Opens: ${opens}`;
        clickHandler = () => {
          const dashboardUrl = `${matched.baseUrl || "https://email-tracker.duckdns.org"}/dashboard?email_id=${encodeURIComponent(
            matched.emailId
          )}`;
          window.open(dashboardUrl, "_blank", "noopener,noreferrer");
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

      badge.onclick = clickHandler;
    });
  } finally {
    isRenderingBadges = false;
  }
}

function findBadgeSlot(row) {
  return (
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
