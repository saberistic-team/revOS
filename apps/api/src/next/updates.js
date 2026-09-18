import { h, button } from "./core.js";

let watcher = null;

/** Keep an open workspace intact; only an explicit native refresh loads a new UI. */
export function watchInterfaceUpdates() {
  if (watcher) return watcher;
  const version = document.querySelector(
    'meta[name="revos-ui-version"]',
  )?.content;
  if (!version) return null;
  let busy = false,
    stopped = false,
    notice = null,
    request = null;
  async function check() {
    if (stopped || busy || document.hidden) return;
    busy = true;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/next-api/ui-version", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const current = await response.json();
      if (
        stopped ||
        typeof current.version !== "string" ||
        !current.version.trim() ||
        current.version === version ||
        notice
      )
        return;
      notice = h(
        "div",
        { id: "nx-ui-update", class: "nx-toast nx-ui-update", role: "status" },
        h("span", {}, "A new interface version is available."),
        // Native reload runs the existing beforeunload draft guard. Never bypass it.
        button("Refresh", () => location.reload(), { class: "nx-small" }),
      );
      (document.querySelector("#nx-notifications") || document.body).append(
        notice,
      );
    } catch {
      // Version discovery is optional and must not interrupt the active workspace.
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
      busy = false;
    }
  }
  const visibility = () => {
    if (!document.hidden) void check();
  };
  document.addEventListener("visibilitychange", visibility);
  const interval = setInterval(() => void check(), 30000);
  watcher = {
    check,
    stop() {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      request?.abort();
    },
  };
  void check();
  return watcher;
}
