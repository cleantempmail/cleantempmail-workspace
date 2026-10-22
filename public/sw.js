// Service Worker：接收 Web Push（空推送），拉取最新邮件后显示系统通知
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      // 页面正开着且可见时不弹系统通知（页面自己会提示）
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (clients.some((c) => c.visibilityState === "visible")) return;
      const en = !(self.navigator.language || "").toLowerCase().startsWith("zh");
      let title = "CleanTempMail Workspace";
      let body = en ? "New mail" : "收到新邮件";
      let url = "/#/inbox";
      try {
        const since = Math.floor(Date.now() / 1000) - 600;
        const res = await fetch(`/api/poll?recent=1&since=${since}`, { credentials: "same-origin" });
        if (res.ok) {
          const d = await res.json();
          const m = d.recent?.[0];
          if (m) {
            title = m.from_name || m.from_addr;
            body = en
              ? `${m.subject || "(no subject)"}\nTo ${m.mailbox}${d.recent.length > 1 ? ` · ${d.recent.length} new` : ""}`
              : `${m.subject || "（无主题）"}\n发到 ${m.mailbox}${d.recent.length > 1 ? `　等 ${d.recent.length} 封` : ""}`;
            url = `/#/inbox/t/${encodeURIComponent(m.thread_id)}`;
          }
          if (d.unread) self.navigator.setAppBadge?.(d.unread).catch(() => {});
        }
      } catch {}
      await self.registration.showNotification(title, { body, icon: "/brand/apple-touch-icon.png?v=3", badge: "/brand/favicon-32.png?v=3", tag: "new-mail", renotify: true, data: { url } });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          c.navigate?.(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
