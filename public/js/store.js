// 全局状态 + 简单事件总线 + 路由
export const store = {
  me: null,
  domains: [],
  stats: { unread: 0, mailboxes: [], drafts: 0, latestInboxAt: 0 },
  identities: [],
  labels: [],
  settings: null,
  route: { view: "inbox", arg: null, thread: null, page: null },
  list: { threads: [], next: null, loading: false, selected: new Set(), filter: "all", q: "", key: "" },
  thread: null, // { threadId, messages }
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  listeners.get(evt)?.forEach((fn) => fn(data));
}

export const MAIL_VIEWS = ["inbox", "snoozed", "starred", "sent", "drafts", "archive", "spam", "trash", "all", "box", "domain", "label"];
export const PAGES = ["settings", "domains", "addresses"];
export const VIEW_META = {
  inbox: { title: "收件箱", icon: "inbox" },
  snoozed: { title: "稍后提醒", icon: "clock" },
  starred: { title: "星标邮件", icon: "star" },
  sent: { title: "已发送", icon: "send" },
  drafts: { title: "草稿", icon: "draft" },
  archive: { title: "归档", icon: "archive" },
  spam: { title: "垃圾邮件", icon: "shieldAlert" },
  trash: { title: "垃圾箱", icon: "trash" },
  all: { title: "全部邮件", icon: "layers" },
};

// #/inbox  #/inbox/t/<thread>  #/box/<addr>/t/<thread>  #/settings/<tab>  #/domains
export function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const view = parts[0] || "inbox";
  if (view === "settings") return { view, page: parts[1] || "general" };
  if (view === "domains" || view === "addresses") return { view };
  const hasArg = view === "box" || view === "domain" || view === "label";
  const arg = hasArg ? parts[1] ?? null : null;
  const rest = parts.slice(hasArg ? 2 : 1);
  const thread = rest[0] === "t" ? rest[1] ?? null : null;
  return { view: MAIL_VIEWS.includes(view) ? view : "inbox", arg, thread };
}

export function hrefFor(view, arg, thread) {
  let h = "#/" + view;
  if (arg) h += "/" + encodeURIComponent(arg);
  if (thread) h += "/t/" + encodeURIComponent(thread);
  return h;
}

export function navigate(view, arg, thread) {
  const h = hrefFor(view, arg, thread);
  if (location.hash !== h) location.hash = h;
}

export const isAdmin = () => store.me?.role === "admin";

export function viewTitle(route = store.route) {
  if (route.view === "box") return route.arg;
  if (route.view === "domain") return "@" + route.arg;
  if (route.view === "label") return store.labels.find((l) => l.id === route.arg)?.name ?? "标签";
  return VIEW_META[route.view]?.title ?? "邮件";
}
