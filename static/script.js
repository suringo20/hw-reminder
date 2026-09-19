const form = document.getElementById("add-form");
const banner = document.getElementById("due-tomorrow-banner");
const installBtn = document.getElementById("install-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const offsetCheckboxes = Array.from(document.querySelectorAll(".offset-checkbox"));
const submitBtn = document.getElementById("submit-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const titleInput = document.getElementById("title");
const subjectInput = document.getElementById("subject");
const dueDateInput = document.getElementById("dueDate");
const dueTimeInput = document.getElementById("dueTime");
const notesInput = document.getElementById("notes");
const testNotificationBtn = document.getElementById("test-notification-btn");
const notificationStatus = document.getElementById("notification-status");

function isIos() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function iosNeedsHomeScreen() {
  return isIos() && !isStandalone();
}

function updateNotificationStatus() {
  if (iosNeedsHomeScreen()) {
    notificationStatus.textContent =
      'On iPhone/iPad, notifications only work once this is added to your Home Screen: tap the Share icon, then "Add to Home Screen", then open the app from there instead of Safari.';
  } else if (!("Notification" in window)) {
    notificationStatus.textContent = "Notifications aren't supported in this browser.";
  } else if (Notification.permission === "denied") {
    notificationStatus.textContent = "Blocked — enable notifications for this site in your browser settings.";
  } else if (Notification.permission === "granted") {
    notificationStatus.textContent = "";
  } else {
    notificationStatus.textContent = "Not yet enabled — click the button to allow notifications.";
  }
}

testNotificationBtn.addEventListener("click", async () => {
  if (iosNeedsHomeScreen() || !("Notification" in window)) {
    updateNotificationStatus();
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission === "granted") {
    new Notification("Test notification", {
      body: "If you can see this, notifications are working on this device.",
      icon: "/icons/icon-192.png",
    });
    notificationStatus.textContent = "Sent! Check your notifications.";
    syncPushSubscription();
  } else {
    updateNotificationStatus();
  }
});

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
    // Only day-granularity offsets are deliverable by the once-a-day cron.
    const dayOffsets = loadSettings().offsets.filter((m) => m >= 1440);
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), items, dayOffsets }),
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
const NOTIFIED_KEY = "hw-notified-offsets";

// Selectable reminder trigger points, each independent -- an item can fire
// several of these. Values are minutes before the due date+time.
const OFFSET_OPTIONS = [2880, 1440, 60, 5, 0];

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw === null) return { offsets: [1440] }; // first run default: 1 day before
  try {
    const s = JSON.parse(raw);
    return { offsets: Array.isArray(s.offsets) ? s.offsets.filter((m) => OFFSET_OPTIONS.includes(m)) : [] };
  } catch {
    return { offsets: [1440] };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
  updateNotificationStatus();
});

function applySettingsInputs(settings) {
  offsetCheckboxes.forEach((cb) => {
    cb.checked = settings.offsets.includes(Number(cb.value));
  });
}

offsetCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    const offsets = offsetCheckboxes.filter((c) => c.checked).map((c) => Number(c.value));
    saveSettings({ offsets });
    render();
    checkReminders();
  });
});

function offsetPhrase(minutes) {
  if (minutes === 0) return "due now";
  if (minutes < 60) return `due in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 1440) {
    const h = minutes / 60;
    return `due in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = minutes / 1440;
  return `due in ${d} day${d === 1 ? "" : "s"}`;
}

// Fires a notification for each selected offset (2 days before, 1 hour
// before, right when due, etc.) the moment that trigger point is reached.
// Each (item, offset) pair notifies at most once, tracked in localStorage.
// Only fires while this tab/app is open -- there's no background push here;
// see api/send-reminders.py for the day-level reminders that work when closed.
function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const settings = loadSettings();
  if (settings.offsets.length === 0) return;
  const now = Date.now();
  const items = loadItems().filter((i) => !i.done);
  const validIds = new Set(items.map((i) => i.id));
  const notified = new Set(
    JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "[]").filter((k) => validIds.has(k.split(":")[0]))
  );
  for (const item of items) {
    const dueMs = dueDateTime(item).getTime();
    for (const offset of settings.offsets) {
      const key = `${item.id}:${offset}`;
      if (dueMs - offset * 60000 <= now && !notified.has(key)) {
        new Notification("Homework reminder", {
          body: `${item.title} — ${offsetPhrase(offset)}`,
          icon: "/icons/icon-192.png",
        });
        notified.add(key);
      }
    }
  }
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified]));
}

setInterval(checkReminders, 20000);

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

function updateItem(id, payload) {
  const items = loadItems();
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.title = payload.title;
  item.subject = payload.subject || "";
  item.dueDate = payload.dueDate;
  item.dueTime = payload.dueTime || "";
  item.notes = payload.notes || "";
  saveItems(items);
  // Notification history is tied to the old due date/time -- clear it for
  // this item so edited reminders can fire again under the new schedule.
  const notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "[]").filter(
    (k) => k.split(":")[0] !== id
  );
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
}

function deleteItem(id) {
  saveItems(loadItems().filter((i) => i.id !== id));
  if (editingId === id) cancelEdit();
}

let editingId = null;

function startEdit(item) {
  editingId = item.id;
  titleInput.value = item.title;
  subjectInput.value = item.subject || "";
  dueDateInput.value = item.dueDate;
  dueTimeInput.value = item.dueTime || "";
  notesInput.value = item.notes || "";
  submitBtn.textContent = "Save changes";
  cancelEditBtn.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  titleInput.focus();
}

function cancelEdit() {
  editingId = null;
  form.reset();
  submitBtn.textContent = "Add";
  cancelEditBtn.classList.add("hidden");
}

cancelEditBtn.addEventListener("click", cancelEdit);

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

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.title = "Edit";
  editBtn.textContent = "✎";
  editBtn.onclick = () => startEdit(item);

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
  li.appendChild(editBtn);
  li.appendChild(delBtn);
  return li;
}

function render() {
  const items = loadItems();
  const settings = loadSettings();
  applySettingsInputs(settings);
  const now = new Date();
  const windowEnd = addDaysStr(1); // "Due Soon" is just a display grouping, independent of notification settings

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
    banner.textContent = `⏰ ${dueSoonItems.length} assignment${dueSoonItems.length > 1 ? "s" : ""} due within 1 day!`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

  checkReminders();
  syncPushSubscription();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const subject = subjectInput.value.trim();
  const dueDate = dueDateInput.value;
  const dueTime = dueTimeInput.value;
  const notes = notesInput.value.trim();
  if (!title || !dueDate) return;
  if (editingId) {
    updateItem(editingId, { title, subject, dueDate, dueTime, notes });
    cancelEdit();
  } else {
    addItem({ title, subject, dueDate, dueTime, notes });
    form.reset();
  }
  render();
});

render();
