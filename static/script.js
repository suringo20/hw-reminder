const form = document.getElementById("add-form");
const banner = document.getElementById("due-tomorrow-banner");
const installBtn = document.getElementById("install-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const leadDaysInput = document.getElementById("lead-days");
const frequencyInput = document.getElementById("frequency");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then(() => syncPushSubscription())
      .catch(() => {});
  });
}

// Public VAPID key for this deployment -- safe to expose client-side.
const VAPID_PUBLIC_KEY =
  "BJMDx0ZiupRR9GRiiVFDRWSuieTczTYoRxS5CpDt6Pn2UTkF51Vmt1zQy8WQ6waltQupocVcrJEhcPEQu4udEkw";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Registers (or refreshes) this device's push subscription with the server
// and sends it the current pending homework, so the daily "due tomorrow"
// cron job (see api/send-reminders.py) can notify even if this tab is
// closed. Fails silently if push isn't supported or the backend isn't
// configured yet -- the in-app reminders keep working either way.
async function syncPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const items = loadItems()
      .filter((i) => !i.done)
      .map((i) => ({ id: i.id, title: i.title, dueDate: i.dueDate }));
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), items }),
    });
  } catch {
    // Push unavailable or backend not set up yet -- ignore.
  }
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.remove("hidden");
});
installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
});
window.addEventListener("appinstalled", () => {
  installBtn.classList.add("hidden");
});

if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission().then((perm) => {
    if (perm === "granted") syncPushSubscription();
  });
}

const SETTINGS_KEY = "hw-settings";
const NOTIFIED_KEY = "hw-notified";

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      leadDays: Number.isFinite(s.leadDays) ? s.leadDays : 1,
      frequency: s.frequency === "daily" ? "daily" : "once",
    };
  } catch {
    return { leadDays: 1, frequency: "once" };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.removeItem(NOTIFIED_KEY); // reset dedup history so the new settings take effect right away
}

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});

function applySettingsInputs(settings) {
  leadDaysInput.value = settings.leadDays;
  frequencyInput.value = settings.frequency;
}

[leadDaysInput, frequencyInput].forEach((el) => {
  el.addEventListener("change", () => {
    const leadDays = Math.max(0, Math.min(30, parseInt(leadDaysInput.value, 10) || 0));
    leadDaysInput.value = leadDays;
    saveSettings({ leadDays, frequency: frequencyInput.value });
    render();
  });
});

// Notify according to the user's chosen frequency: "once" ever per item, or
// "daily" (at most once per calendar day per item) until it's done.
function notifyDueSoon(items, frequency) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const today = todayStr();
  const notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "{}");
  const fresh = items.filter((i) => {
    const last = notified[i.id];
    return frequency === "daily" ? last !== today : !last;
  });
  if (fresh.length === 0) return;
  const body = fresh.length === 1
    ? fresh[0].title
    : `${fresh.length} assignments: ${fresh.map((i) => i.title).join(", ")}`;
  new Notification("Homework due soon", { body, icon: "/icons/icon-192.png" });
  fresh.forEach((i) => (notified[i.id] = today));
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
}

const DUE_NOW_KEY = "hw-notified-due-now";
let lastDueCheck = Date.now();

// Fires a notification the moment an assignment's exact due date+time is
// reached, independent of the "remind me N days before" setting above.
// Only fires while this tab is open and running -- there's no background
// push, so closing the browser means missing it.
function checkDueNow() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  const items = loadItems().filter((i) => !i.done);
  const validIds = new Set(items.map((i) => i.id));
  const notified = new Set(
    JSON.parse(localStorage.getItem(DUE_NOW_KEY) || "[]").filter((id) => validIds.has(id))
  );
  for (const item of items) {
    const t = dueDateTime(item).getTime();
    if (t > lastDueCheck && t <= now && !notified.has(item.id)) {
      new Notification("Homework due now", { body: item.title, icon: "/icons/icon-192.png" });
      notified.add(item.id);
    }
  }
  localStorage.setItem(DUE_NOW_KEY, JSON.stringify([...notified]));
  lastDueCheck = now;
}

setInterval(checkDueNow, 20000);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatTime(timeStr) {
  const d = new Date(`2000-01-01T${timeStr}:00`);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDueMeta(item) {
  const date = formatDate(item.dueDate);
  return item.dueTime ? `${date}, ${formatTime(item.dueTime)}` : date;
}

// Full due timestamp, treating "no time set" as end-of-day for sorting/overdue purposes.
function dueDateTime(item) {
  return new Date(`${item.dueDate}T${item.dueTime || "23:59"}:00`);
}

const ITEMS_KEY = "hw-items";

function loadItems() {
  try {
    return JSON.parse(localStorage.getItem(ITEMS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveItems(items) {
  localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
}

function addItem(payload) {
  const item = {
    id: crypto.randomUUID(),
    title: payload.title,
    subject: payload.subject || "",
    dueDate: payload.dueDate,
    dueTime: payload.dueTime || "",
    notes: payload.notes || "",
    done: false,
  };
  const items = loadItems();
  items.push(item);
  saveItems(items);
  return item;
}

function toggleDone(id, done) {
  const items = loadItems();
  const item = items.find((i) => i.id === id);
  if (item) {
    item.done = done;
    saveItems(items);
  }
}

function deleteItem(id) {
  saveItems(loadItems().filter((i) => i.id !== id));
}

function makeItemEl(item, kind) {
  const li = document.createElement("li");
  li.className = `hw-item ${kind}`;

  const info = document.createElement("div");
  info.className = "info";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = item.title;
  const meta = document.createElement("div");
  meta.className = "meta";
  const bits = [formatDueMeta(item)];
  if (item.subject) bits.unshift(item.subject);
  if (item.notes) bits.push(item.notes);
  meta.textContent = bits.join(" · ");
  info.appendChild(title);
  info.appendChild(meta);

  const doneBtn = document.createElement("button");
  doneBtn.className = "icon-btn";
  doneBtn.title = item.done ? "Mark as not done" : "Mark as done";
  doneBtn.textContent = item.done ? "↺" : "✓";
  doneBtn.onclick = () => {
    toggleDone(item.id, !item.done);
    render();
  };

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn delete";
  delBtn.title = "Delete";
  delBtn.textContent = "✕";
  delBtn.onclick = () => {
    deleteItem(item.id);
    render();
  };

  li.appendChild(info);
  li.appendChild(doneBtn);
  li.appendChild(delBtn);
  return li;
}

function render() {
  const items = loadItems();
  const settings = loadSettings();
  applySettingsInputs(settings);
  const now = new Date();
  const windowEnd = addDaysStr(settings.leadDays);

  const overdueEl = document.getElementById("list-overdue");
  const dueSoonEl = document.getElementById("list-tomorrow");
  const upcomingEl = document.getElementById("list-upcoming");
  const doneEl = document.getElementById("list-done");
  [overdueEl, dueSoonEl, upcomingEl, doneEl].forEach((el) => (el.innerHTML = ""));

  const pending = items.filter((i) => !i.done).sort((a, b) => dueDateTime(a) - dueDateTime(b));
  const done = items.filter((i) => i.done).sort((a, b) => dueDateTime(b) - dueDateTime(a));

  const dueSoonItems = [];
  for (const item of pending) {
    if (dueDateTime(item) < now) {
      overdueEl.appendChild(makeItemEl(item, "overdue"));
    } else if (item.dueDate <= windowEnd) {
      dueSoonEl.appendChild(makeItemEl(item, "tomorrow"));
      dueSoonItems.push(item);
    } else {
      upcomingEl.appendChild(makeItemEl(item, ""));
    }
  }
  for (const item of done) {
    doneEl.appendChild(makeItemEl(item, "done"));
  }

  if (dueSoonItems.length > 0) {
    const window = settings.leadDays === 0 ? "today" : `within ${settings.leadDays} day${settings.leadDays > 1 ? "s" : ""}`;
    banner.textContent = `⏰ ${dueSoonItems.length} assignment${dueSoonItems.length > 1 ? "s" : ""} due ${window}!`;
    banner.classList.remove("hidden");
    notifyDueSoon(dueSoonItems, settings.frequency);
  } else {
    banner.classList.add("hidden");
  }

  syncPushSubscription();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = document.getElementById("title").value.trim();
  const subject = document.getElementById("subject").value.trim();
  const dueDate = document.getElementById("dueDate").value;
  const dueTime = document.getElementById("dueTime").value;
  const notes = document.getElementById("notes").value.trim();
  if (!title || !dueDate) return;
  addItem({ title, subject, dueDate, dueTime, notes });
  form.reset();
  render();
});

render();
