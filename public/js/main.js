// CleanTempMail Workspace —— 入口：布局、侧栏、路由、轮询、快捷键
import { api } from "./api.js";
import { composerHasUnsaved, hasPendingSends, openComposer, reattachInline } from "./compose.js";
import { icon } from "./icons.js";
import { createLabel, loadList, moveSelection, renderList, snoozeMenu, threadAction } from "./list.js";
import { BRAND, renderAddressesPage, renderDomainsPage, renderLogin, renderSetup } from "./pages.js";
import { initI18n } from "./i18n.js";
import { refreshPush } from "./push-client.js";
import { clearThread, loadThread, readerMenuShortcut, renderReader, replyToCurrent, threadShortcut } from "./reader.js";
import { renderSettingsPage, shortcutsModal } from "./settings.js";
import { emit, hrefFor, isAdmin, navigate, on, PAGES, parseHash, store, VIEW_META, viewTitle } from "./store.js";
import { menu, toast } from "./ui.js";
import { $, avatarColor, esc, lang, prefs } from "./util.js";

const root = document.getElementById("app");

// ---------- 偏好：主题、密度、阅读窗格、列表宽度 ----------
function applyPrefs() {
  const theme = prefs.get("theme", "auto");
  const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.density = prefs.get("density", "comfortable");
  document.documentElement.dataset.pane = prefs.get("readingPane", "right");
  document.documentElement.style.setProperty("--list-w", prefs.get("listWidth", 400) + "px");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0c0e11" : "#f3f4f7");
  const tb = document.querySelector("[data-theme-btn]");
  if (tb) tb.innerHTML = icon(dark ? "moon" : "sun");
}
applyPrefs();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyPrefs);
on("prefs:changed", applyPrefs);

// ---------- 启动 ----------
async function boot() {
  await initI18n();
  store.me = await api("/me");
  if (!store.me.loggedIn) {
    document.title = "登录 · CleanTempMail Workspace";
    // 还没有管理员：首次设置（粘贴 API 令牌 + 设置密码）；本地开发模式直接显示登录页
    return store.me.unclaimed && !store.me.devLogin ? renderSetup(root) : renderLogin(root);
  }
  const [domains, stats, identities, settings, labels, addresses] = await Promise.all([
    api("/domains"),
    api("/stats"),
    api("/identities"),
    api("/settings"),
    api("/labels"),
    api("/addresses").catch(() => []),
  ]);
  Object.assign(store, { domains, stats, identities, settings, labels, addresses });
  renderShell();
  window.addEventListener("hashchange", onRoute);
  await onRoute();
  startPolling();
  bindShortcuts();
  refreshPush();
}

// ---------- 外框 ----------
function renderShell() {
  root.innerHTML = `
  <a class="skip-link" href="#main">跳到邮件列表</a>
  <div class="app">
    <aside class="sidebar" aria-label="导航"></aside>
    <div class="sidebar-backdrop"></div>
    <div class="content">
      <header class="topbar">
        <button class="icon-btn mobile-only" data-menu aria-label="菜单">${icon("menu")}</button>
        <div class="search" role="search">
          ${icon("search")}
          <input id="search" type="search" placeholder="${matchMedia("(max-width: 760px)").matches ? "搜索邮件" : "搜索邮件：主题、发件人、地址、内容"}" autocomplete="off" aria-label="搜索邮件" />
          <kbd class="search-kbd">/</kbd>
          <div class="search-hints" hidden></div>
        </div>
        <div class="topbar-right">
          <button class="icon-btn" data-theme-btn title="切换外观" aria-label="切换外观">${icon(document.documentElement.dataset.theme === "dark" ? "moon" : "sun")}</button>
          <button class="icon-btn" data-help title="快捷键 (?)" aria-label="快捷键">${icon("keyboard")}</button>
          <button class="user-btn" data-user aria-label="账户菜单"><span class="avatar sm" style="--av:${avatarColor(store.me.email)}">${esc((store.me.email || "?")[0].toUpperCase())}</span></button>
        </div>
      </header>
      <main class="workspace" id="main">
        <section class="list-pane" aria-label="邮件列表"></section>
        <div class="resizer" role="separator" aria-orientation="vertical" aria-label="调整列表宽度" aria-valuemin="300" aria-valuemax="720" aria-valuenow="${prefs.get("listWidth", 400)}" tabindex="0"></div>
        <section class="reader-pane" aria-label="阅读"></section>
        <section class="page-pane" hidden></section>
      </main>
    </div>
    <button class="fab mobile-only" data-compose aria-label="写邮件">${icon("pen")}</button>
    <nav class="tabbar mobile-only" aria-label="快捷导航"></nav>
  </div>`;

  bindSearch();
  bindResizer();
  $("[data-menu]").onclick = () => document.querySelector(".app").classList.add("nav-open");
  $(".sidebar-backdrop").onclick = () => document.querySelector(".app").classList.remove("nav-open");
  $("[data-compose]").onclick = () => openComposer();
  $("[data-help]").onclick = () => shortcutsModal();
  $("[data-theme-btn]").onclick = (e) => {
    const cur = prefs.get("theme", "auto");
    menu(e.currentTarget, [
      { header: "外观" },
      ...[
        ["auto", "跟随系统", "monitor"],
        ["light", "浅色", "sun"],
        ["dark", "深色", "moon"],
      ].map(([v, label, ic]) => ({ label, icon: ic, active: cur === v, onClick: () => (prefs.set("theme", v), applyPrefs()) })),
    ]);
  };
  $("[data-user]").onclick = (e) =>
    menu(e.currentTarget, [
      { header: `${store.me.email || "已登录"}${isAdmin() ? " · 管理员" : " · 成员"}` },
      { label: "设置", icon: "settings", onClick: () => (location.hash = "#/settings/general") },
      { label: "身份与签名", icon: "signature", onClick: () => (location.hash = "#/settings/identities") },
      { label: "地址管理", icon: "at", onClick: () => (location.hash = "#/addresses") },
      isAdmin() ? { label: "域名管理", icon: "globe", onClick: () => (location.hash = "#/domains") } : null,
      "-",
      {
        label: "退出登录",
        icon: "logout",
        onClick: async () => {
          await fetch("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
          location.href = "/";
        },
      },
    ].filter(Boolean));
}

// ---------- 搜索：输入框 + 语法提示 ----------
const EN_UI = lang() === "en";
const HINTS = [
  ["from:", "发件人", "from:github.com"],
  ["to:", "收件地址", "to:sales@"],
  ["subject:", "主题", EN_UI ? "subject:invoice" : "subject:发票"],
  [EN_UI ? "has:attachment" : "has:附件", "有附件", EN_UI ? "has:attachment" : "has:附件"],
  [EN_UI ? "is:unread" : "is:未读", "未读", EN_UI ? "is:unread" : "is:未读"],
  [EN_UI ? "is:starred" : "is:星标", "星标", EN_UI ? "is:starred" : "is:星标"],
  ["before:", "某日之前", "before:2026-10-01"],
  ["after:", "某日之后", "after:2026-09-01"],
  ["in:trash", "在垃圾箱中搜索", "in:trash"],
];
function bindSearch() {
  const search = $("#search");
  const hints = $(".search-hints");
  const showHints = () => {
    if (search.value.trim()) return (hints.hidden = true);
    hints.innerHTML = `<div class="hint-title">搜索语法（可组合使用）</div>${HINTS.map(([k, d, ex]) => `<button type="button" class="hint" data-k="${esc(k)}"><code>${esc(ex)}</code><span>${d}</span></button>`).join("")}`;
    hints.hidden = false;
  };
  search.addEventListener("focus", showHints);
  search.addEventListener("input", showHints);
  search.addEventListener("blur", () => setTimeout(() => (hints.hidden = true), 150));
  hints.addEventListener("mousedown", (e) => {
    const b = e.target.closest(".hint");
    if (!b) return;
    e.preventDefault();
    search.value = b.dataset.k + (b.dataset.k.endsWith(":") ? "" : " ");
    hints.hidden = true;
    search.focus();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      store.list.q = search.value.trim();
      const v = store.route.view;
      if (PAGES.includes(v) || v === "drafts") navigate("all");
      else {
        if (store.route.thread) navigate(v, store.route.arg, null);
        loadList();
      }
      search.blur();
    } else if (e.key === "Escape") {
      search.value = "";
      if (store.list.q) {
        store.list.q = "";
        loadList();
      }
      search.blur();
    }
  });
  search.addEventListener("search", () => {
    if (!search.value && store.list.q) {
      store.list.q = "";
      loadList();
    }
  });
}

// ---------- 拖动调整列表宽度 ----------
function bindResizer() {
  const rz = $(".resizer");
  let startX = 0;
  let startW = 0;
  const onMove = (e) => {
    const w = Math.max(300, Math.min(720, startW + e.clientX - startX));
    document.documentElement.style.setProperty("--list-w", w + "px");
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.classList.remove("resizing");
    prefs.set("listWidth", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--list-w")) || 400);
    rz.setAttribute("aria-valuenow", String(prefs.get("listWidth", 400)));
  };
  rz.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startW = $(".list-pane").getBoundingClientRect().width;
    document.body.classList.add("resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
  rz.addEventListener("dblclick", () => {
    prefs.set("listWidth", 400);
    applyPrefs();
  });
  rz.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const w = Math.max(300, Math.min(720, $(".list-pane").getBoundingClientRect().width + (e.key === "ArrowRight" ? 20 : -20)));
    prefs.set("listWidth", w);
    applyPrefs();
  });
}

// ---------- 侧栏 ----------
// 手机底部标签栏：收件箱 / 星标 / 已发送 / 更多（打开侧栏）
function renderTabbar() {
  const bar = $(".tabbar");
  if (!bar) return;
  const v = store.route.view;
  const unread = store.stats?.unread || 0;
  const tab = (view, ic, label, badge = 0) =>
    `<a class="tab ${v === view ? "on" : ""}" href="${hrefFor(view)}" ${v === view ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span>${badge ? `<b class="tab-badge">${badge > 99 ? "99+" : badge}</b>` : ""}</a>`;
  bar.innerHTML = `${tab("inbox", "inbox", "收件箱", unread)}${tab("starred", "star", "星标")}${tab("sent", "send", "已发送")}
    <button class="tab" data-tab-more aria-label="更多">${icon("menu")}<span>更多</span></button>`;
  bar.querySelector("[data-tab-more]").onclick = () => document.querySelector(".app").classList.add("nav-open");
}

function renderSidebar() {
  renderTabbar();
  const el = $(".sidebar");
  if (!el) return;
  const r = store.route;
  const s = store.stats;
  const active = (view, arg) => r.view === view && (r.arg || null) === (arg || null);
  const item = (view, { count, strong } = {}) => {
    const meta = VIEW_META[view];
    return `<a class="nav-item ${active(view) ? "active" : ""}" href="${hrefFor(view)}" ${active(view) ? 'aria-current="page"' : ""}>${icon(meta.icon)}<span class="nav-label">${meta.title}</span>${
      count ? `<span class="nav-count ${strong ? "strong" : ""}">${count > 999 ? "999+" : count}</span>` : ""
    }</a>`;
  };
  const addrInfo = new Map((store.addresses || []).map((a) => [a.address, a]));
  // 域名多于 2 个时，默认只展开第一个；用户手动展开/收起后按用户的来
  const collapsed = new Set(prefs.get("collapsedDomains", null) ?? (store.domains.length > 2 ? store.domains.slice(1).map((d) => d.name) : []));
  const domains = store.domains
    .map((d) => {
      const boxes = s.mailboxes.filter((m) => m.domain === d.name);
      const unread = boxes.reduce((a, b) => a + (b.unread || 0), 0);
      const isCollapsed = collapsed.has(d.name);
      const shown = boxes.slice(0, prefs.get("expandAll:" + d.name, false) ? 999 : 6);
      return `<div class="nav-domain ${isCollapsed ? "collapsed" : ""}">
        <div class="nav-item domain ${active("domain", d.name) ? "active" : ""}">
          <button class="nav-caret" data-toggle-domain="${esc(d.name)}" aria-label="展开/收起 ${esc(d.name)}" aria-expanded="${!isCollapsed}">${icon("chevronDown")}</button>
          <a href="${hrefFor("domain", d.name)}" class="nav-domain-link"><span class="dot" style="--av:${avatarColor(d.name)}"></span><span class="nav-label">${esc(d.name)}</span></a>
          ${unread ? `<span class="nav-count">${unread}</span>` : ""}
        </div>
        <div class="nav-sub">${shown
          .map((b) => {
            const info = addrInfo.get(b.mailbox);
            return `<a class="nav-item sub ${active("box", b.mailbox) ? "active" : ""} ${info?.blocked ? "blocked" : ""}" href="${hrefFor("box", b.mailbox)}" title="${esc(b.mailbox)}${info?.note ? " · " + esc(info.note) : ""}">
              ${info?.color ? `<span class="addr-dot" style="--lc:${esc(info.color)}"></span>` : ""}
              <span class="nav-label">${esc(b.mailbox.split("@")[0])}<span class="muted">@</span>${info?.note ? `<span class="nav-note">${esc(info.note)}</span>` : ""}</span>
              ${info?.muted ? icon("bellOff", "nav-mini") : ""}${b.unread ? `<span class="nav-count">${b.unread}</span>` : ""}</a>`;
          })
          .join("")}${boxes.length > 6 && shown.length <= 6 ? `<button class="nav-more" data-expand-domain="${esc(d.name)}">还有 ${boxes.length - 6} 个地址…</button>` : ""}
          ${!boxes.length ? `<span class="nav-empty">还没有收到邮件</span>` : ""}</div>
      </div>`;
    })
    .join("");
  const labelCounts = new Map((s.labels || []).map((l) => [l.label_id, l]));
  const labels = store.labels
    .map((l) => {
      const c = labelCounts.get(l.id);
      return `<a class="nav-item ${active("label", l.id) ? "active" : ""}" href="${hrefFor("label", l.id)}"><span class="label-dot" style="--lc:${esc(l.color)}"></span><span class="nav-label">${esc(l.name)}</span>${c?.unread ? `<span class="nav-count">${c.unread}</span>` : ""}</a>`;
    })
    .join("");

  el.innerHTML = `
    <div class="sb-brand"><a href="#/inbox" aria-label="CleanTempMail Workspace 收件箱">${BRAND}</a></div>
    <button class="btn primary compose-btn" data-compose-side>${icon("pen")}<span>写邮件</span><kbd>c</kbd></button>
    <nav class="sb-nav" aria-label="文件夹">
      ${item("inbox", { count: s.unread, strong: true })}
      ${s.snoozed ? item("snoozed", { count: s.snoozed }) : item("snoozed")}
      ${item("starred")}
      ${item("sent")}
      ${item("drafts", { count: s.drafts })}
      ${item("archive")}
      ${item("spam", { count: s.spam })}
      ${item("trash")}
      ${item("all")}
    </nav>
    <div class="sb-section">
      <div class="sb-title"><span>标签</span><button class="icon-btn xs" data-new-label title="新建标签" aria-label="新建标签">${icon("plus")}</button></div>
      ${labels || `<button class="sb-empty" data-new-label>${icon("tag")}新建标签</button>`}
    </div>
    <div class="sb-section grow">
      <div class="sb-title"><span>域名与地址</span>${isAdmin() ? `<a href="#/domains" class="icon-btn xs" title="添加 / 管理域名" aria-label="管理域名">${icon("plus")}</a>` : ""}</div>
      ${domains || (isAdmin() ? `<a class="sb-empty" href="#/domains">${icon("plus")}添加第一个域名</a>` : `<span class="nav-empty">暂无可访问的域名</span>`)}
    </div>
    <div class="sb-bottom">
      <a class="nav-item ${r.view === "addresses" ? "active" : ""}" href="#/addresses">${icon("at")}<span class="nav-label">地址管理</span></a>
      ${isAdmin() ? `<a class="nav-item ${r.view === "domains" ? "active" : ""}" href="#/domains">${icon("globe")}<span class="nav-label">域名管理</span></a>` : ""}
      <a class="nav-item ${r.view === "settings" ? "active" : ""}" href="#/settings/general">${icon("settings")}<span class="nav-label">设置</span></a>
    </div>`;
  el.querySelector("[data-compose-side]").onclick = () => openComposer();
  el.querySelectorAll("[data-new-label]").forEach((b) => (b.onclick = () => createLabel()));
  el.querySelectorAll("[data-toggle-domain]").forEach(
    (b) =>
      (b.onclick = () => {
        const n = b.dataset.toggleDomain;
        collapsed.has(n) ? collapsed.delete(n) : collapsed.add(n);
        prefs.set("collapsedDomains", [...collapsed]);
        renderSidebar();
      }),
  );
  el.querySelectorAll("[data-expand-domain]").forEach(
    (b) =>
      (b.onclick = () => {
        prefs.set("expandAll:" + b.dataset.expandDomain, true);
        renderSidebar();
      }),
  );
  el.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => document.querySelector(".app")?.classList.remove("nav-open")));
}

// ---------- 路由 ----------
async function onRoute() {
  const r = parseHash();
  const prev = store.route;
  store.route = r;
  const isPage = PAGES.includes(r.view);
  if (isPage) reattachInline(null, null); // 阅读区要隐藏了：内嵌的回复转成浮动窗口（写过内容）或收起
  $(".list-pane").hidden = isPage;
  $(".reader-pane").hidden = isPage;
  $(".resizer").hidden = isPage;
  $(".page-pane").hidden = !isPage;
  $(".workspace").classList.toggle("paged", isPage);
  renderSidebar();
  updateTitle();
  if (isPage) {
    // 每次渲染用一个新容器：快速切换时，较慢的旧渲染只会写进已被替换掉的容器，不会覆盖新页面
    const pane = $(".page-pane");
    const host = document.createElement("div");
    host.className = "page-host";
    if (prev.view !== r.view || prev.page !== r.page || !pane.firstChild) pane.replaceChildren(host);
    else pane.firstChild.replaceWith(host);
    pane.scrollTop = 0;
    try {
      if (r.view === "domains") await renderDomainsPage(host);
      else if (r.view === "addresses") await renderAddressesPage(host);
      else await renderSettingsPage(host, r.page);
    } catch (e) {
      host.innerHTML = `<div class="page"><div class="notice err">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    }
    return;
  }
  const viewChanged = prev.view !== r.view || prev.arg !== r.arg || !store.list.key;
  if (viewChanged) {
    store.list.filter = "all";
    if (prev.view && store.list.key && !PAGES.includes(prev.view)) {
      store.list.q = "";
      const s = $("#search");
      if (s) s.value = "";
    }
    loadList();
  } else renderList();
  if (r.thread) {
    if (store.thread?.threadId !== r.thread) loadThread(r.thread);
    else renderReader();
  } else clearThread();
}

function updateTitle() {
  const n = store.stats.unread;
  const r = store.route;
  const t = r.view === "settings" ? "设置" : r.view === "domains" ? "域名管理" : r.view === "addresses" ? "地址管理" : viewTitle();
  document.title = `${n ? `(${n}) ` : ""}${t} · CleanTempMail Workspace`;
  setFaviconBadge(n);
  navigator.setAppBadge?.(n || undefined)?.catch?.(() => {});
}

// favicon 上显示未读数
let faviconImg;
function setFaviconBadge(n) {
  const link = document.querySelector('link[rel="icon"][type="image/png"]') ?? document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (!n) {
    link.href = "/brand/favicon-32.png?v=3";
    return;
  }
  const draw = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.drawImage(faviconImg, 0, 0, 64, 64);
    const label = n > 99 ? "99+" : String(n);
    const w = Math.max(30, 16 + label.length * 14);
    g.fillStyle = "#ff3b30";
    g.beginPath();
    g.roundRect(64 - w, 0, w, 34, 17);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 26px -apple-system, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, 64 - w / 2, 18);
    link.href = c.toDataURL("image/png");
  };
  if (faviconImg?.complete) return draw();
  faviconImg = new Image();
  faviconImg.onload = draw;
  faviconImg.src = "/brand/favicon-32.png?v=3";
}

// ---------- 数据刷新 ----------
async function refreshStats() {
  try {
    const prev = store.stats;
    store.stats = await api("/stats");
    renderSidebar();
    updateTitle();
    return prev;
  } catch {
    return null;
  }
}

on("stats:refresh", refreshStats);
on("mail:changed", async (opts) => {
  await refreshStats();
  if (!PAGES.includes(store.route.view)) {
    loadList({ silent: true });
    if (store.route.thread && !opts?.keepThread) loadThread(store.route.thread);
  }
});
on("drafts:changed", async () => {
  await refreshStats();
  if (store.route.view === "drafts") loadList({ silent: true });
});
on("scheduled:changed", () => store.route.view === "drafts" && loadList({ silent: true }));
on("domains:refresh", async () => {
  store.domains = await api("/domains").catch(() => store.domains);
  renderSidebar();
  if (store.route.view === "domains") renderDomainsPage($(".page-pane .page-host") ?? $(".page-pane"));
});
on("labels:changed", async () => {
  store.labels = await api("/labels").catch(() => store.labels);
  await refreshStats();
  if (!PAGES.includes(store.route.view)) renderList();
});
on("addresses:changed", async () => {
  store.addresses = await api("/addresses").catch(() => store.addresses);
  renderSidebar();
});

// 轻量轮询：可见时 30 秒、后台时 2 分钟；只有计数变化才刷新列表
function startPolling() {
  let last = { unread: store.stats.unread, latestInboxAt: store.stats.latestInboxAt };
  let timer;
  const tick = async () => {
    clearTimeout(timer);
    try {
      const p = await api("/poll");
      if (p.latestInboxAt !== last.latestInboxAt || p.unread !== last.unread) {
        const isNew = last.latestInboxAt && p.latestInboxAt > last.latestInboxAt;
        last = p;
        await refreshStats();
        const v = store.route.view;
        if (["inbox", "all", "box", "domain", "label"].includes(v) && !store.list.selected.size) loadList({ silent: true });
        if (isNew && !document.hidden) toast("收到新邮件", { action: v !== "inbox" ? { label: "查看", onClick: () => navigate("inbox") } : undefined });
      }
    } catch {}
    timer = setTimeout(tick, document.hidden ? 120000 : 30000);
  };
  timer = setTimeout(tick, 30000);
  document.addEventListener("visibilitychange", () => !document.hidden && tick());
}

// ---------- 快捷键 ----------
function bindShortcuts() {
  let gPending = 0;
  document.addEventListener("keydown", (e) => {
    if (!prefs.get("shortcuts", true)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.("input, textarea, select, [contenteditable=true], .modal-backdrop, .lightbox, .composer")) return;
    if (document.querySelector(".modal-backdrop, .lightbox, .menu")) return;
    const r = store.route;
    const inMail = !PAGES.includes(r.view);
    const k = e.key;
    if (gPending && Date.now() - gPending < 1200) {
      gPending = 0;
      const go = { i: "inbox", s: "starred", t: "sent", d: "drafts", a: "all", e: "archive", b: "snoozed" }[k];
      if (go) {
        e.preventDefault();
        navigate(go);
      }
      return;
    }
    switch (k) {
      case "g":
        gPending = Date.now();
        return;
      case "c":
        e.preventDefault();
        openComposer();
        return;
      case "/":
        e.preventDefault();
        $("#search")?.focus();
        return;
      case "?":
        shortcutsModal();
        return;
    }
    if (!inMail) return;
    // 列表行内的方向键/回车由列表自己处理
    if (t.closest?.(".list-body") && ["Enter", " ", "ArrowUp", "ArrowDown"].includes(k)) return;
    switch (k) {
      case "j":
        moveSelection(1);
        break;
      case "k":
        moveSelection(-1);
        break;
      case "o":
      case "Enter":
        if (!r.thread && store.list.threads[0] && !store.list.threads[0].isDraft) navigate(r.view, r.arg, store.list.threads[0].thread_id);
        break;
      case "u":
      case "Escape":
        if (r.thread) navigate(r.view, r.arg, null);
        else if (store.list.selected.size) {
          store.list.selected.clear();
          renderList();
        }
        break;
      case "e":
        if (r.thread) threadShortcut(r.view === "archive" ? "unarchive" : "archive");
        else if (store.list.selected.size) threadAction([...store.list.selected], "archive");
        break;
      case "#":
        if (r.thread) threadShortcut(r.view === "trash" ? "delete" : "trash");
        else if (store.list.selected.size) threadAction([...store.list.selected], "trash");
        break;
      case "!":
        if (r.thread) threadShortcut(r.view === "spam" ? "notspam" : "spam");
        else if (store.list.selected.size) threadAction([...store.list.selected], "spam");
        break;
      case "b":
        if (r.thread) readerMenuShortcut("snooze");
        else if (store.list.selected.size) snoozeMenu($(".list-head") ?? document.body, [...store.list.selected]);
        break;
      case "l":
        if (r.thread) readerMenuShortcut("labels");
        break;
      case "s": {
        const tid = r.thread;
        if (tid) {
          const row = store.list.threads.find((x) => x.thread_id === tid);
          threadShortcut(row?.any_star || store.thread?.messages?.some((m) => m.starred) ? "unstar" : "star");
        }
        break;
      }
      case "U":
        if (r.thread) threadShortcut("unread");
        break;
      case "x":
        if (r.thread) {
          store.list.selected.has(r.thread) ? store.list.selected.delete(r.thread) : store.list.selected.add(r.thread);
          renderList();
        }
        break;
      case "r":
        if (r.thread) replyToCurrent("reply");
        break;
      case "a":
        if (r.thread) replyToCurrent("replyAll");
        break;
      case "f":
        if (r.thread) replyToCurrent("forward");
        break;
      default:
        return;
    }
    e.preventDefault();
  });
}

// 有未保存的内容或正在倒计时发送时，离开页面前提醒
window.addEventListener("beforeunload", (e) => {
  if (hasPendingSends() || composerHasUnsaved()) e.preventDefault();
});

boot().catch((e) => {
  root.innerHTML = `<div class="fatal"><img src="/brand/logo.svg?v=3" alt="" width="56" /><h2>加载失败</h2><p>${esc(e.message)}</p><button class="btn" data-retry>重试</button></div>`;
  root.querySelector("[data-retry]").onclick = () => location.reload();
});

export { emit };
