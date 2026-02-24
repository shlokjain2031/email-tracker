const STORAGE_KEYS = {
  USER_ID: "tracker_user_id",
  TRACKER_BASE_URL: "tracker_base_url",
  RECENT_EMAILS: "recent_tracked_emails",
  DASHBOARD_TOKEN: "dashboard_token"
};

const DEFAULT_TRACKER_BASE_URL = "https://email-tracker.duckdns.org";
const RECENT_LIMIT = 100;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRACKER_BASE_URL]: DEFAULT_TRACKER_BASE_URL
  });

  await ensureUserId();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "tracker:getComposeTrackingData") {
      const userId = await ensureUserId();
      const emailId = crypto.randomUUID();
      const sentAt = new Date().toISOString();
      const recipient = (message.recipient || "unknown").trim();
      const senderEmail = String(message.senderEmail || "").trim().toLowerCase() || null;
      const baseUrl = await getTrackerBaseUrl();
      const token = encodeTrackingToken({
        user_id: userId,
        email_id: emailId,
        recipient,
        sender_email: senderEmail ?? undefined,
        sent_at: sentAt
      });
      const pixelUrl = `${baseUrl}/t/${token}.gif`;

      sendResponse({ ok: true, userId, emailId, sentAt, recipient, senderEmail, token, pixelUrl, baseUrl });
      return;
    }

    if (message?.type === "tracker:logTrackedEmail") {
      await appendRecentTrackedEmail(message.payload);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "tracker:getInboxBadgeData") {
      const trackerBaseUrl = await getTrackerBaseUrl();
      const {
        [STORAGE_KEYS.RECENT_EMAILS]: recentEmails = [],
        [STORAGE_KEYS.DASHBOARD_TOKEN]: dashboardToken = ""
      } = await chrome.storage.local.get([
        STORAGE_KEYS.RECENT_EMAILS,
        STORAGE_KEYS.DASHBOARD_TOKEN
      ]);

      const enriched = await enrichRecentEmails(recentEmails, trackerBaseUrl, dashboardToken);
      sendResponse({ ok: true, trackerBaseUrl, items: enriched });
      return;
    }

    if (message?.type === "tracker:getPopupData") {
      const userId = await ensureUserId();
      const trackerBaseUrl = await getTrackerBaseUrl();
      const {
        [STORAGE_KEYS.RECENT_EMAILS]: recentEmails = [],
        [STORAGE_KEYS.DASHBOARD_TOKEN]: dashboardToken = ""
      } = await chrome.storage.local.get([
        STORAGE_KEYS.RECENT_EMAILS,
        STORAGE_KEYS.DASHBOARD_TOKEN
      ]);

      const enrichedRecentEmails = await enrichRecentEmails(recentEmails, trackerBaseUrl, dashboardToken);
      const debugItems = await getPopupDebugItems(enrichedRecentEmails, trackerBaseUrl, dashboardToken);

      sendResponse({
        ok: true,
        userId,
        trackerBaseUrl,
        dashboardToken,
        recentEmails,
        enrichedRecentEmails,
        debugItems,
        debugGeneratedAt: new Date().toISOString()
      });
      return;
    }

    if (message?.type === "tracker:markSuppressNext") {
      const emailId = String(message.emailId || "").trim();
      const result = await markSuppressNextForEmail(emailId);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "tracker:updateTrackerBaseUrl") {
      const trackerBaseUrl = normalizeBaseUrl(message.baseUrl || "");
      await chrome.storage.local.set({ [STORAGE_KEYS.TRACKER_BASE_URL]: trackerBaseUrl });
      sendResponse({ ok: true, trackerBaseUrl });
      return;
    }

    if (message?.type === "tracker:updateDashboardToken") {
      const dashboardToken = String(message.dashboardToken || "").trim();
      await chrome.storage.local.set({ [STORAGE_KEYS.DASHBOARD_TOKEN]: dashboardToken });
      sendResponse({ ok: true, dashboardToken });
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
      senderEmail: payload.senderEmail || "",
      subject: payload.subject || "",
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

async function getTrackerBaseUrl() {
  const { [STORAGE_KEYS.TRACKER_BASE_URL]: trackerBaseUrl } = await chrome.storage.local.get(STORAGE_KEYS.TRACKER_BASE_URL);
  const normalized = normalizeBaseUrl(trackerBaseUrl || DEFAULT_TRACKER_BASE_URL);
  if (!trackerBaseUrl) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TRACKER_BASE_URL]: normalized });
  }

  return normalized;
}

async function enrichRecentEmails(recentEmails, trackerBaseUrl, dashboardToken) {
  const normalizedBaseUrl = normalizeBaseUrl(trackerBaseUrl || DEFAULT_TRACKER_BASE_URL);

  if (!dashboardToken) {
    return recentEmails.map((item) => ({
      ...item,
      totalOpenEvents: 0,
      uniqueOpenCount: 0,
      lastOpenedAt: null
    }));
  }

  try {
    const response = await fetch(`${normalizedBaseUrl}/dashboard/api/emails`, {
      headers: {
        "X-Tracker-Token": dashboardToken
      }
    });

    if (!response.ok) {
      return recentEmails.map((item) => ({
        ...item,
        totalOpenEvents: 0,
        uniqueOpenCount: 0,
        lastOpenedAt: null
      }));
    }

    const payload = await response.json();
    const serverItems = Array.isArray(payload?.items) ? payload.items : [];
    const byEmailId = new Map(serverItems.map((item) => [item.email_id, item]));

    return recentEmails.map((item) => {
      const matched = byEmailId.get(item.emailId);
      return {
        ...item,
        recipient: matched?.recipient || item.recipient || "unknown",
        senderEmail: matched?.sender_email || item.senderEmail || "",
        totalOpenEvents: matched?.total_open_events ?? 0,
        uniqueOpenCount: matched?.unique_open_count ?? 0,
        lastOpenedAt: matched?.last_opened_at ?? null
      };
    });
  } catch {
    return recentEmails.map((item) => ({
      ...item,
      totalOpenEvents: 0,
      uniqueOpenCount: 0,
      lastOpenedAt: null
    }));
  }
}

async function getPopupDebugItems(items, trackerBaseUrl, dashboardToken) {
  const normalizedBaseUrl = normalizeBaseUrl(trackerBaseUrl || DEFAULT_TRACKER_BASE_URL);
  const trackerHost = safeHostFromUrl(normalizedBaseUrl);

  if (!dashboardToken) {
    return items.map((item) => ({
      emailId: item.emailId,
      recipient: item.recipient || "unknown",
      subject: item.subject || "",
      pixelUrl: item.pixelUrl || "",
      pixelHost: safeHostFromUrl(item.pixelUrl),
      trackerHost,
      hostMatchesTracker: safeHostFromUrl(item.pixelUrl) === trackerHost,
      totalOpenEvents: Number(item.totalOpenEvents || 0),
      uniqueOpenCount: Number(item.uniqueOpenCount || 0),
      lastOpenedAt: item.lastOpenedAt || null,
      backendReachable: null,
      backendStatus: "token missing"
    }));
  }

  const debugItems = [];

  for (const item of items) {
    const pixelHost = safeHostFromUrl(item.pixelUrl);
    const hostMatchesTracker = pixelHost === trackerHost;
    const eventProbe = await getLatestEventForEmail(item.emailId, normalizedBaseUrl, dashboardToken);

    debugItems.push({
      emailId: item.emailId,
      recipient: item.recipient || "unknown",
      subject: item.subject || "",
      pixelUrl: item.pixelUrl || "",
      pixelHost,
      trackerHost,
      hostMatchesTracker,
      totalOpenEvents: Number(item.totalOpenEvents || 0),
      uniqueOpenCount: Number(item.uniqueOpenCount || 0),
      lastOpenedAt: item.lastOpenedAt || null,
      backendReachable: eventProbe.ok,
      backendStatus: eventProbe.error || "ok",
      latestEventAt: eventProbe.latestEventAt,
      latestEventDuplicate: eventProbe.latestEventDuplicate
    });
  }

  return debugItems;
}

async function getLatestEventForEmail(emailId, baseUrl, dashboardToken) {
  if (!emailId) {
    return { ok: false, error: "missing email id", latestEventAt: null, latestEventDuplicate: null };
  }

  try {
    const response = await fetch(`${baseUrl}/dashboard/api/open-events?email_id=${encodeURIComponent(emailId)}`, {
      headers: {
        "X-Tracker-Token": dashboardToken
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `open-events http ${response.status}`,
        latestEventAt: null,
        latestEventDuplicate: null
      };
    }

    const payload = await response.json();
    const first = Array.isArray(payload?.items) && payload.items.length > 0 ? payload.items[0] : null;

    return {
      ok: true,
      error: null,
      latestEventAt: first?.opened_at ?? null,
      latestEventDuplicate: typeof first?.is_duplicate === "number" ? first.is_duplicate === 1 : null
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      latestEventAt: null,
      latestEventDuplicate: null
    };
  }
}

function safeHostFromUrl(url) {
  try {
    return new URL(String(url || "")).host;
  } catch {
    return "";
  }
}

async function markSuppressNextForEmail(emailId) {
  if (!emailId) {
    return { sent: false, reason: "missing email id" };
  }

  const normalizedBaseUrl = await getTrackerBaseUrl();

  try {
    const response = await fetch(`${normalizedBaseUrl}/mark-suppress-next`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email_id: emailId }),
      cache: "no-store",
      credentials: "omit"
    });

    if (!response.ok) {
      return { sent: false, reason: `http ${response.status}` };
    }

    return { sent: true, reason: "ok" };
  } catch (error) {
    return { sent: false, reason: String(error?.message || error) };
  }
}

function encodeTrackingToken(payload) {
  const compactPayload = [
    payload.user_id,
    payload.email_id,
    payload.recipient,
    payload.sent_at,
    payload.sender_email
  ];

  if (!compactPayload[4]) {
    compactPayload.length = 4;
  }

  const json = JSON.stringify(compactPayload);
  const bytes = new TextEncoder().encode(json);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
