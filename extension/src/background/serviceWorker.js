const STORAGE_KEYS = {
  USER_ID: "tracker_user_id",
  TRACKER_BASE_URL: "tracker_base_url",
  RECENT_EMAILS: "recent_tracked_emails"
};

const DEFAULT_TRACKER_BASE_URL = "https://email-tracker.duckdns.org";
const LEGACY_TRACKER_BASE_URLS = new Set(["http://localhost:8080", "http://localhost:8090"]);
const RECENT_LIMIT = 100;

chrome.runtime.onInstalled.addListener(async () => {
  const { [STORAGE_KEYS.TRACKER_BASE_URL]: trackerBaseUrl } = await chrome.storage.local.get(
    STORAGE_KEYS.TRACKER_BASE_URL
  );

  if (!trackerBaseUrl || LEGACY_TRACKER_BASE_URLS.has(String(trackerBaseUrl).trim())) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.TRACKER_BASE_URL]: DEFAULT_TRACKER_BASE_URL
    });
  }

  await ensureUserId();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "tracker:getComposeTrackingData") {
      const userId = await ensureUserId();
      const emailId = crypto.randomUUID();
      const sentAt = new Date().toISOString();
      const recipient = (message.recipient || "unknown").trim();
      const { [STORAGE_KEYS.TRACKER_BASE_URL]: rawBaseUrl } = await chrome.storage.local.get(
        STORAGE_KEYS.TRACKER_BASE_URL
      );

      const baseUrl = normalizeBaseUrl(rawBaseUrl || DEFAULT_TRACKER_BASE_URL);
      const token = encodeTrackingToken({ user_id: userId, email_id: emailId, recipient, sent_at: sentAt });
      const pixelUrl = `${baseUrl}/t/${token}.gif`;

      sendResponse({ ok: true, userId, emailId, sentAt, recipient, token, pixelUrl, baseUrl });
      return;
    }

    if (message?.type === "tracker:logTrackedEmail") {
      await appendRecentTrackedEmail(message.payload);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "tracker:getPopupData") {
      const userId = await ensureUserId();
      const {
        [STORAGE_KEYS.RECENT_EMAILS]: recentEmails = [],
        [STORAGE_KEYS.TRACKER_BASE_URL]: trackerBaseUrl = DEFAULT_TRACKER_BASE_URL
      } = await chrome.storage.local.get([STORAGE_KEYS.RECENT_EMAILS, STORAGE_KEYS.TRACKER_BASE_URL]);

      sendResponse({ ok: true, userId, trackerBaseUrl, recentEmails });
      return;
    }

    if (message?.type === "tracker:updateTrackerBaseUrl") {
      const baseUrl = normalizeBaseUrl(message.baseUrl || "");
      await chrome.storage.local.set({ [STORAGE_KEYS.TRACKER_BASE_URL]: baseUrl });
      sendResponse({ ok: true, trackerBaseUrl: baseUrl });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});

async function ensureUserId() {
  const { [STORAGE_KEYS.USER_ID]: existingUserId } = await chrome.storage.local.get(STORAGE_KEYS.USER_ID);
  if (existingUserId) return existingUserId;

  const newUserId = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_ID]: newUserId });
  return newUserId;
}

async function appendRecentTrackedEmail(payload) {
  if (!payload?.emailId) {
    return;
  }

  const { [STORAGE_KEYS.RECENT_EMAILS]: existing = [] } = await chrome.storage.local.get(
    STORAGE_KEYS.RECENT_EMAILS
  );

  const next = [
    {
      emailId: payload.emailId,
      recipient: payload.recipient || "unknown",
      sentAt: payload.sentAt,
      pixelUrl: payload.pixelUrl
    },
    ...existing
  ].slice(0, RECENT_LIMIT);

  await chrome.storage.local.set({ [STORAGE_KEYS.RECENT_EMAILS]: next });
}

function normalizeBaseUrl(url) {
  const normalized = String(url || "").trim();
  if (!normalized) {
    return DEFAULT_TRACKER_BASE_URL;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("Tracker URL must start with http:// or https://");
  }

  return normalized.replace(/\/+$/, "");
}

function encodeTrackingToken(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
