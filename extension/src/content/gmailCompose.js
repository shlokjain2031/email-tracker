const TRACKER_PIXEL_MARKER = "data-email-tracker-pixel";

init();

function init() {
  attachComposeObserver();
  scanForComposeDialogs();
}

function attachComposeObserver() {
  const observer = new MutationObserver(() => {
    scanForComposeDialogs();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scanForComposeDialogs() {
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  dialogs.forEach((dialog) => {
    if (dialog.dataset.emailTrackerBound === "1") {
      return;
    }

    dialog.dataset.emailTrackerBound = "1";
    bindSendHook(dialog);
  });
}

function bindSendHook(dialog) {
  dialog.addEventListener(
    "click",
    async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const sendButton = target.closest('div[role="button"],button');
      if (!sendButton || !isSendButton(sendButton)) {
        return;
      }

      await injectTrackingPixelIfNeeded(dialog);
    },
    true
  );
}

function isSendButton(button) {
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

async function injectTrackingPixelIfNeeded(dialog) {
  const body = findComposeBody(dialog);
  if (!body) {
    return;
  }

  if (body.querySelector(`img[${TRACKER_PIXEL_MARKER}]`)) {
    return;
  }

  const recipient = getPrimaryRecipient(dialog);

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

  body.appendChild(img);

  await chrome.runtime.sendMessage({
    type: "tracker:logTrackedEmail",
    payload: {
      emailId: response.emailId,
      recipient: response.recipient,
      sentAt: response.sentAt,
      pixelUrl: response.pixelUrl
    }
  });
}

function findComposeBody(dialog) {
  return (
    dialog.querySelector('div[aria-label="Message Body"]') ||
    dialog.querySelector('div[role="textbox"][contenteditable="true"]')
  );
}

function getPrimaryRecipient(dialog) {
  const recipientNode = dialog.querySelector('[name="to"] [email], [email][data-hovercard-id]');
  const direct = recipientNode?.getAttribute("email");

  if (direct) {
    return direct;
  }

  const chips = Array.from(dialog.querySelectorAll('[email]')).map((el) => el.getAttribute("email")).filter(Boolean);
  if (chips.length > 0) {
    return chips.join(",");
  }

  return "unknown";
}
