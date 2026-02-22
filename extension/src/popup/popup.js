const userIdNode = document.getElementById("userId");
const trackerUrlInput = document.getElementById("trackerUrl");
const dashboardTokenInput = document.getElementById("dashboardToken");
const saveUrlBtn = document.getElementById("saveUrl");
const statusNode = document.getElementById("status");
const recentListNode = document.getElementById("recentList");

loadPopupData();

saveUrlBtn.addEventListener("click", async () => {
  setStatus("");

  const urlResponse = await chrome.runtime.sendMessage({
    type: "tracker:updateTrackerBaseUrl",
    baseUrl: trackerUrlInput.value
  });

  if (!urlResponse?.ok) {
    setStatus(urlResponse?.error || "Could not save URL", true);
    return;
  }

  const tokenResponse = await chrome.runtime.sendMessage({
    type: "tracker:updateDashboardToken",
    dashboardToken: dashboardTokenInput.value
  });

  if (!tokenResponse?.ok) {
    setStatus(tokenResponse?.error || "Could not save token", true);
    return;
  }

  trackerUrlInput.value = urlResponse.trackerBaseUrl;
  dashboardTokenInput.value = tokenResponse.dashboardToken;
  setStatus("Tracker URL and token saved");
});

async function loadPopupData() {
  const response = await chrome.runtime.sendMessage({ type: "tracker:getPopupData" });
  if (!response?.ok) {
    userIdNode.textContent = "Unavailable";
    renderRecent([]);
    return;
  }

  userIdNode.textContent = response.userId;
  trackerUrlInput.value = response.trackerBaseUrl;
  dashboardTokenInput.value = response.dashboardToken || "";
  renderRecent(response.recentEmails || []);
}

function renderRecent(items) {
  recentListNode.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tracked emails yet.";
    recentListNode.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = "item";
    wrapper.innerHTML = `
      <div><strong>Recipient:</strong> ${escapeHtml(item.recipient || "unknown")}</div>
      <div><strong>Email ID:</strong> <span class="mono">${escapeHtml(item.emailId || "")}</span></div>
      <div><strong>Sent At:</strong> ${escapeHtml(item.sentAt || "")}</div>
    `;
    recentListNode.appendChild(wrapper);
  });
}

function setStatus(text, isError = false) {
  statusNode.textContent = text;
  statusNode.style.color = isError ? "#d93025" : "#188038";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
