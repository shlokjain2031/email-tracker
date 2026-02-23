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
      border: 0;
      border-radius: 7px;
      padding: 2px 8px;
      margin-left: 8px;
      background: #8b5cf6;
      color: #fff;
      font-size: 12px;
      line-height: 16px;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      vertical-align: middle;
    }

    .et-opens-badge.et-muted {
      background: #ede9fe;
      color: #7c3aed;
    }
  `;

  document.head.appendChild(style);
}

function scanForComposeDialogs() {
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  dialogs.forEach((dialog) => {
    injectTrackingPixelIfNeeded(dialog);
  });
}

async function injectTrackingPixelIfNeeded(dialog) {
  const body = findComposeBody(dialog);
  if (!body) {
    return;
  }

  if (body.querySelector(`img[${TRACKER_PIXEL_MARKER}]`)) {
    return;
  }

  const recipient = getPrimaryRecipient(dialog);
  const subject = getSubject(dialog);

  const response = await chrome.runtime.sendMessage({
    type: "tracker:getComposeTrackingData",
    recipient
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
  marker.style.cssText = "display:none!important;max-height:0;overflow:hidden;";
  marker.textContent = "";

  body.appendChild(marker);
  body.appendChild(img);

  chrome.runtime.sendMessage({
    type: "tracker:logTrackedEmail",
    payload: {
      emailId: response.emailId,
      recipient: response.recipient,
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
  const selectors = [
    'input[name="to"]',
    'textarea[name="to"]',
    'div[aria-label="To"] input',
    'div[aria-label="To"] textarea'
  ];

  for (const selector of selectors) {
    const node = dialog.querySelector(selector);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      const value = (node.value || node.textContent || "").trim();
      if (value) {
        return value;
      }
    }
  }

  const chipSet = new Set();
  const chipNodes = dialog.querySelectorAll('[email], [data-hovercard-id][email]');
  chipNodes.forEach((chip) => {
    const email = chip.getAttribute("email") || chip.getAttribute("data-hovercard-id");
    if (email) {
      chipSet.add(email.trim());
    }
  });

  if (chipSet.size > 0) {
    return Array.from(chipSet).join(",");
  }

  return "unknown";
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

      let badge = slot.querySelector(".et-opens-badge");
      if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = "et-opens-badge";
        slot.appendChild(badge);
      }

      let nextText = "Unopened";
      let muted = true;
      let clickHandler = null;

      if (matched) {
        const opens = Number(matched.totalOpenEvents || 0);
        nextText = opens > 0 ? `Opens:${opens}` : "Unopened";
        muted = opens === 0;
        clickHandler = () => {
          const dashboardUrl = `${matched.baseUrl || "https://email-tracker.duckdns.org"}/dashboard?email_id=${encodeURIComponent(
            matched.emailId
          )}`;
          window.open(dashboardUrl, "_blank", "noopener,noreferrer");
        };
      }

      const stateKey = `${nextText}|${muted ? "1" : "0"}|${matched?.emailId || "none"}`;
      if (badge.dataset.stateKey !== stateKey) {
        badge.textContent = nextText;
        badge.classList.toggle("et-muted", muted);
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
    row.querySelector("td")
  );
}

function findTrackedItemForRow(row) {
  if (!row || !inboxBadgeItems.length) {
    return null;
  }

  const marker = row.querySelector('[data-email-tracker-marker]');
  const emailIdFromMarker = marker?.dataset?.snv;
  if (emailIdFromMarker) {
    const exact = inboxBadgeItems.find((item) => String(item.emailId || "").toLowerCase() === emailIdFromMarker.toLowerCase());
    if (exact) {
      return {
        ...exact,
        baseUrl: exact.pixelUrl ? extractBaseUrl(exact.pixelUrl) : "https://email-tracker.duckdns.org"
      };
    }
  }

  const rowText = row.textContent?.toLowerCase() || "";

  const markerEmailId = extractMarkerEmailId(rowText);
  if (markerEmailId) {
    const exact = inboxBadgeItems.find(
      (item) => String(item.emailId || "").toLowerCase() === markerEmailId
    );

    if (exact) {
      return {
        ...exact,
        baseUrl: exact.pixelUrl ? extractBaseUrl(exact.pixelUrl) : "https://email-tracker.duckdns.org"
      };
    }
  }

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

function extractMarkerEmailId(rowText) {
  const match = String(rowText || "").match(/snv:([0-9a-f-]{36})/i);
  return match?.[1]?.toLowerCase() || null;
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
