// Scheduled tasks via chrome.alarms.
// A schedule stores a prompt, an interval and an optional URL. On each tick we
// open a background tab, run the agent, store the result, notify, then close.

import { getSchedules, saveSchedules, getSettings } from "./storage.js";
import { runTask } from "./run-task.js";
import { assertBrandIntact } from "./brand-guard.js";
import { playChime } from "./offscreen-host.js";
import { nextRun } from "../shared/schedules.js";

const ALARM_PREFIX = "autobot_sched_";
const MIN_PERIOD_MIN = 1;

// Runs on every service-worker start. Re-creating an alarm restarts its
// countdown, so an alarm that already matches its schedule is left alone;
// otherwise a worker that restarts more often than the interval never fires.
export async function syncAlarms() {
  const existing = await chrome.alarms.getAll().catch(() => []);
  const armed = new Map(
    existing.filter((a) => a.name.startsWith(ALARM_PREFIX)).map((a) => [a.name, a])
  );
  const schedules = await getSchedules();
  const wanted = new Set();

  for (const s of schedules) {
    if (!s.enabled) continue;
    const name = ALARM_PREFIX + s.id;
    const current = armed.get(name);
    const repeat = s.repeatType || "interval";
    if (repeat !== "interval") {
      const when = nextRun(s, Date.now());
      if (!when) continue;
      wanted.add(name);
      if (!current || current.periodInMinutes || current.scheduledTime !== when) {
        chrome.alarms.create(name, { when });
      }
      continue;
    }
    const period = Math.max(MIN_PERIOD_MIN, Number(s.everyMinutes) || 60);
    wanted.add(name);
    if (!current || current.periodInMinutes !== period) {
      chrome.alarms.create(name, { periodInMinutes: period, delayInMinutes: period });
    }
  }

  for (const name of armed.keys()) {
    if (!wanted.has(name)) await chrome.alarms.clear(name);
  }
  return schedules;
}

export async function runScheduledTask(id) {
  const schedules = await getSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const s = schedules[idx];
  if (!s.enabled) return null;

  let tabId = null;
  let createdTab = false;
  let result = null;
  let keepalive = null;

  try {
    // A copy whose name or logo was changed runs no tasks (shared/brand.js).
    await assertBrandIntact();
    // A scheduled run has no side-panel port keeping the worker alive.
    keepalive = setInterval(() => {
      try {
        Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => {});
      } catch {}
    }, 20000);

    const tab = await chrome.tabs.create({ url: s.url || "about:blank", active: false });
    tabId = tab.id;
    createdTab = true;
    // Give the page a moment to load and the content script to attach.
    for (let i = 0; i < 40; i++) {
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current || current.status === "complete") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 400));
    result = await runTask({ text: s.prompt, tabId });
    const final = [...result.conversation]
      .reverse()
      .find((m) => m.role === "assistant" && m.content);
    const once = (s.repeatType || "interval") === "once";
    schedules[idx] = {
      ...s,
      enabled: once ? false : s.enabled,
      lastRunAt: Date.now(),
      lastStatus: "ok",
      lastResult: String(final?.content || "(no answer)").slice(0, 2000),
    };
  } catch (e) {
    schedules[idx] = {
      ...s,
      lastRunAt: Date.now(),
      lastStatus: "error",
      lastResult: String(e?.message || e).slice(0, 2000),
    };
  } finally {
    if (keepalive) clearInterval(keepalive);
    if (createdTab && schedules[idx]?.closeTab !== false && tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
    await saveSchedules(schedules);
    const entry = schedules[idx];
    try {
      chrome.notifications.create(`autobot_task_${id}_${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `Akron: ${s.title || "Scheduled task"}`,
        message: String(entry?.lastResult || "").slice(0, 200) || "(no result)",
      });
    } catch {}
    const notifySettings = await getSettings().catch(() => ({}));
    if (notifySettings.soundOnComplete !== false) playChime();
  }

  return schedules[idx];
}

export function installScheduler() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    runScheduledTask(alarm.name.slice(ALARM_PREFIX.length));
  });

  chrome.runtime.onInstalled.addListener(() => {
    syncAlarms();
  });
  chrome.runtime.onStartup.addListener(() => {
    syncAlarms();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autobot_schedules) syncAlarms();
  });

  syncAlarms();
}
