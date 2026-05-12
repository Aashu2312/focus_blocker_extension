let isBlocking = false;
let blockedSites = [];
let breakEndTime = null;

// Track which tabs we've injected the overlay into
const blockedTabs = new Set();

// ═══════════════════════════════════════════
// 📊 Stats tracking helpers
// ═══════════════════════════════════════════
function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-04-10"
}

function incrementStat(field, amount = 1) {
  const key = getTodayKey();
  chrome.storage.local.get(["stats"], (result) => {
    const stats = result.stats || {};
    if (!stats[key]) stats[key] = { blockedAttempts: 0, focusMinutes: 0, breaksUsed: 0 };
    stats[key][field] = (stats[key][field] || 0) + amount;
    chrome.storage.local.set({ stats });
  });
}

// Track focus session start time
function startFocusTracking() {
  chrome.storage.local.set({ focusStartTime: Date.now() });
}

function stopFocusTracking() {
  chrome.storage.local.get(["focusStartTime"], (result) => {
    if (result.focusStartTime) {
      const elapsed = Math.floor((Date.now() - result.focusStartTime) / 60000);
      if (elapsed > 0) {
        incrementStat("focusMinutes", elapsed);
      }
      chrome.storage.local.set({ focusStartTime: null });
    }
  });
}

// ═══════════════════════════════════════════

// 📍 Load initial values, then apply to all tabs
chrome.storage.local.get(["blockedSites", "isBlocking", "breakEndTime"], (result) => {
  blockedSites = result.blockedSites || [];
  isBlocking = result.isBlocking ?? false;
  breakEndTime = result.breakEndTime || null;

  // If there was a break, re-register the alarm
  if (breakEndTime && breakEndTime > Date.now()) {
    const remainingMs = breakEndTime - Date.now();
    chrome.alarms.create("breakEnd", { delayInMinutes: remainingMs / 60000 });
    updateBadge();
  } else if (breakEndTime) {
    breakEndTime = null;
    chrome.storage.local.set({ breakEndTime: null });
  }

  // Start focus tracking if blocking is on
  if (isBlocking) {
    chrome.storage.local.get(["focusStartTime"], (r) => {
      if (!r.focusStartTime) startFocusTracking();
    });
  }

  applyToAllTabs();
});

// Set up a periodic alarm to flush focus time (every 5 min)
chrome.alarms.create("focusFlush", { periodInMinutes: 5 });

// 📍 React instantly when settings change from popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const oldBlocking = isBlocking;

  if (changes.isBlocking) {
    isBlocking = changes.isBlocking.newValue;

    // Track focus time
    if (isBlocking && !oldBlocking) {
      startFocusTracking();
    } else if (!isBlocking && oldBlocking) {
      stopFocusTracking();
    }
  }
  if (changes.blockedSites) {
    blockedSites = changes.blockedSites.newValue;
  }
  if (changes.breakEndTime) {
    breakEndTime = changes.breakEndTime.newValue;

    if (breakEndTime && breakEndTime > Date.now()) {
      const remainingMs = breakEndTime - Date.now();
      chrome.alarms.create("breakEnd", { delayInMinutes: remainingMs / 60000 });
      startBadgeCountdown();
      // Pause focus tracking during break
      stopFocusTracking();
    } else {
      breakEndTime = null;
      chrome.alarms.clear("breakEnd");
      clearBadge();
      // Resume focus tracking after break
      if (isBlocking) startFocusTracking();
    }
  }

  applyToAllTabs();
});

// ⏰ Alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "breakEnd") {
    breakEndTime = null;
    chrome.storage.local.set({ breakEndTime: null });
    clearBadge();
    if (isBlocking) startFocusTracking();
    applyToAllTabs();
  }
  if (alarm.name === "focusFlush") {
    // Periodically save accumulated focus time
    if (isBlocking && isEffectivelyBlocking()) {
      chrome.storage.local.get(["focusStartTime"], (result) => {
        if (result.focusStartTime) {
          const elapsed = Math.floor((Date.now() - result.focusStartTime) / 60000);
          if (elapsed > 0) {
            incrementStat("focusMinutes", elapsed);
            chrome.storage.local.set({ focusStartTime: Date.now() });
          }
        }
      });
    }
  }
});

// 🚫 Also block on new navigations
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    handleTab(tab);
  }
});

// 🧹 Clean up tracked tabs when they close
chrome.tabs.onRemoved.addListener((tabId) => {
  blockedTabs.delete(tabId);
});

// ═══════════════════════════════════════════
// Is blocking currently effective?
// ═══════════════════════════════════════════
function isEffectivelyBlocking() {
  if (!isBlocking) return false;
  if (breakEndTime && breakEndTime > Date.now()) return false;
  return true;
}

// ═══════════════════════════════════════════
// Core logic: apply blocking to ALL open tabs
// ═══════════════════════════════════════════
function applyToAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url || !isValidUrl(tab.url)) continue;

      const shouldBlock = isEffectivelyBlocking() && blockedSites.some(site => tab.url.includes(site));
      const wasBlocked = blockedTabs.has(tab.id);

      if (shouldBlock && !wasBlocked) {
        injectBlockOverlay(tab.id);
      } else if (!shouldBlock && wasBlocked) {
        unblockTab(tab.id);
      }
    }
  });
}

function handleTab(tab) {
  if (!tab.url || !isValidUrl(tab.url)) return;

  const shouldBlock = isEffectivelyBlocking() && blockedSites.some(site => tab.url.includes(site));

  if (shouldBlock) {
    injectBlockOverlay(tab.id);
  }
}

function isValidUrl(url) {
  return !url.startsWith("chrome://") &&
         !url.startsWith("chrome-extension://") &&
         !url.startsWith("about:") &&
         !url.startsWith("edge://");
}

// ═══════════════════════════════════════════
// Inject the blocked page overlay
// ═══════════════════════════════════════════
function injectBlockOverlay(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: showBlockedPage,
  }).then(() => {
    blockedTabs.add(tabId);
    // 📊 Track blocked attempt
    incrementStat("blockedAttempts");
  }).catch(() => {});
}

function unblockTab(tabId) {
  blockedTabs.delete(tabId);
  chrome.tabs.reload(tabId).catch(() => {});
}

// ═══════════════════════════════════════════
// Badge: show break countdown on extension icon
// ═══════════════════════════════════════════
let badgeInterval = null;

function startBadgeCountdown() {
  clearBadge();
  chrome.action.setBadgeBackgroundColor({ color: "#6c5ce7" });

  function tick() {
    if (!breakEndTime) { clearBadge(); return; }
    const remaining = breakEndTime - Date.now();
    if (remaining <= 0) { clearBadge(); return; }

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const text = mins >= 10 ? `${mins}m` : `${mins}:${String(secs).padStart(2, "0")}`;
    chrome.action.setBadgeText({ text });
  }

  tick();
  badgeInterval = setInterval(tick, 1000);
}

function updateBadge() {
  if (breakEndTime && breakEndTime > Date.now()) startBadgeCountdown();
}

function clearBadge() {
  if (badgeInterval) { clearInterval(badgeInterval); badgeInterval = null; }
  chrome.action.setBadgeText({ text: "" });
}

// ═══════════════════════════════════════════
// The injected blocked page UI
// ═══════════════════════════════════════════
function showBlockedPage() {
  if (document.getElementById("focus-blocker-overlay")) return;

  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  const container = document.createElement("div");
  container.id = "focus-blocker-overlay";
  container.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    display: flex; justify-content: center; align-items: center; flex-direction: column;
    background: #0f0f1a; color: #e8e8f0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    z-index: 999999; text-align: center; padding: 40px;
  `;

  const bgOrb = document.createElement("div");
  bgOrb.style.cssText = `
    position: absolute; width: 300px; height: 300px; border-radius: 50%;
    background: radial-gradient(circle, rgba(108,92,231,0.2) 0%, transparent 70%);
    top: 50%; left: 50%; transform: translate(-50%, -50%);
    animation: focus-pulse 4s ease-in-out infinite; pointer-events: none;
  `;
  container.appendChild(bgOrb);

  const icon = document.createElement("div");
  icon.textContent = "🛡️";
  icon.style.cssText = `font-size: 56px; margin-bottom: 20px; position: relative; z-index: 1; animation: focus-fadeInUp 0.6s ease forwards;`;
  container.appendChild(icon);

  const title = document.createElement("h1");
  title.textContent = "Site Blocked";
  title.style.cssText = `font-size: 28px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.5px; position: relative; z-index: 1; animation: focus-fadeInUp 0.6s ease 0.1s forwards; opacity: 0;`;
  container.appendChild(title);

  const subtitle = document.createElement("p");
  const quotes = [
    "Stay focused. Your future self will thank you.",
    "Discipline is choosing what you want most over what you want now.",
    "Small steps every day lead to big results.",
    "The secret of getting ahead is getting started.",
    "Focus on being productive, not busy.",
  ];
  subtitle.textContent = quotes[Math.floor(Math.random() * quotes.length)];
  subtitle.style.cssText = `font-size: 15px; color: rgba(232, 232, 240, 0.45); margin: 0 0 32px; max-width: 380px; line-height: 1.5; position: relative; z-index: 1; animation: focus-fadeInUp 0.6s ease 0.2s forwards; opacity: 0;`;
  container.appendChild(subtitle);

  const btn = document.createElement("button");
  btn.textContent = "← Go Back";
  btn.style.cssText = `padding: 12px 28px; background: rgba(108, 92, 231, 0.15); color: #6c5ce7; border: 1px solid rgba(108, 92, 231, 0.3); border-radius: 10px; font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.25s ease; position: relative; z-index: 1; animation: focus-fadeInUp 0.6s ease 0.3s forwards; opacity: 0;`;
  btn.addEventListener("mouseover", () => { btn.style.background = "rgba(108, 92, 231, 0.25)"; btn.style.boxShadow = "0 0 20px rgba(108, 92, 231, 0.2)"; });
  btn.addEventListener("mouseout", () => { btn.style.background = "rgba(108, 92, 231, 0.15)"; btn.style.boxShadow = "none"; });
  btn.addEventListener("click", () => history.back());
  container.appendChild(btn);

  const style = document.createElement("style");
  style.textContent = `
    @keyframes focus-pulse { 0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.5; } 50% { transform: translate(-50%, -50%) scale(1.15); opacity: 0.8; } }
    @keyframes focus-fadeInUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(container);
}