// 会话列表
import { api } from "./api.js";
import { emptyArt, inboxZero } from "./art.js";
import { openComposer } from "./compose.js";
import { icon } from "./icons.js";
import { emit, navigate, store, viewTitle } from "./store.js";
import { confirmDialog, labelMenu, menu, modal, pickDateTime, toast, toastError } from "./ui.js";
import { $, avatar, avatarColor, dateGroup, displayName, esc, fmtListTime, fmtWhen, h, parseList, timePresets } from "./util.js";

const pane = () => $(".list-pane");

// 各视图可用的批量操作（顺序即按钮顺序）
function actionsFor(view) {
  if (view === "trash") return ["restore", "delete"];
  if (view === "spam") return ["notspam", "delete_spam"];
  if (view === "sent") return ["trash", "label", "star"];
  if (view === "archive") return ["unarchive", "trash", "label", "snooze", "read", "unread", "star"];
  if (view === "snoozed") return ["unsnooze", "archive", "trash", "label"];
  if (view === "drafts") return [];
  return ["archive", "trash", "label", "snooze", "read", "unread", "spam", "star"];
}
const ACTION_META = {
  archive: { icon: "archive", label: "归档" },
  unarchive: { icon: "unarchive", label: "移回收件箱" },
  trash: { icon: "trash", label: "删除" },
  restore: { icon: "restore", label: "恢复" },
  delete: { icon: "trash", label: "永久删除" },
  delete_spam: { icon: "trash", label: "永久删除" },
  read: { icon: "mailOpen", label: "已读" },
  unread: { icon: "mail", label: "未读" },
  star: { icon: "star", label: "加星标" },
  unstar: { icon: "star", label: "取消星标" },
  spam: { icon: "shieldAlert", label: "垃圾邮件" },
  notspam: { icon: "inbox", label: "不是垃圾邮件" },
  snooze: { icon: "clock", label: "稍后提醒" },
  unsnooze: { icon: "alarm", label: "取消提醒" },
  label: { icon: "tag", label: "标签" },
};

function listKey() {
  const r = store.route;
  return [r.view, r.arg, store.list.filter, store.list.q].join("|");
}

export async function loadList({ reset = true, silent = false } = {}) {
  const L = store.list;
  const r = store.route;
  const key = listKey();
  if (reset) {
    L.key = key;
    L.next = null;
    if (!silent) {
      L.threads = [];
      L.selected.clear();
      L.loading = true;
      renderList();
    }
  }
  try {
    if (r.view === "drafts") {
      const [drafts, scheduled] = await Promise.all([api("/drafts"), api("/scheduled").catch(() => [])]);
      if (L.key !== key) return;
      L.threads = [
        ...scheduled.map((s) => ({ ...s.payload, scheduledId: s.id, send_at: s.send_at, status: s.status, error: s.error, isDraft: true, thread_id: "sched:" + s.id, updated_at: s.created_at })),
        ...drafts.map((d) => ({ ...d, isDraft: true, thread_id: "draft:" + d.id })),
      ];
      L.next = null;
    } else {
      const p = new URLSearchParams({ view: r.view });
      if (r.arg) p.set("arg", r.arg);
      if (L.q) p.set("q", L.q);
      if (L.filter !== "all") p.set("filter", L.filter);
      if (!reset && L.next) p.set("before", L.next);
      const res = await api("/threads?" + p);
      if (L.key !== key) return; // 用户已切换视图
      L.threads = reset ? res.threads : [...L.threads, ...res.threads];
      L.next = res.next;
    }
  } catch (e) {
    toastError(e);
  } finally {
    if (L.key === key) {
      L.loading = false;
      renderList();
    }
  }
}

const EMPTY = {
  inbox: ["全部处理完了", "收件箱已清空。发到你任何域名、任何地址的新邮件都会出现在这里。"],
  snoozed: ["没有稍后提醒的邮件", "在邮件上点 ⏰ 可以让它在指定时间回到收件箱顶部。"],
  starred: ["还没有星标邮件", "给重要的邮件加星标，方便以后找到。"],
  sent: ["还没有发过邮件", "点「写邮件」开始，或在收到的邮件里直接回复。"],
  drafts: ["没有草稿", "写到一半的邮件和定时发送的邮件会出现在这里。"],
  archive: ["没有归档的邮件", "归档会把邮件移出收件箱，但不会删除。"],
  spam: ["没有垃圾邮件", "被屏蔽、未通过发件人验证或被规则判定的邮件会放在这里，30 天后自动删除。"],
  trash: ["垃圾箱是空的", "删除的邮件会在这里保留 30 天。"],
  all: ["这里还没有邮件", ""],
  box: ["这个地址还没有邮件", ""],
  domain: ["这个域名还没有邮件", ""],
  label: ["这个标签下还没有邮件", "可以在邮件上点 🏷 添加标签，或在设置里用规则自动打标签。"],
};

function emptyState() {
  const r = store.route;
  if (!store.domains.length)
    return `<div class="empty">${emptyArt("globe")}<h3>先添加一个域名</h3><p>选择 Cloudflare 账户中的域名，一键开通收件和发件。</p><a class="btn primary" href="#/domains">${icon("plus")}添加域名</a></div>`;
  if (store.list.q) return `<div class="empty">${emptyArt("search")}<h3>没有找到匹配的邮件</h3><p>换个关键词，或用 from: to: has:附件 is:未读 before:2026-01-01 缩小范围。</p></div>`;
  if (store.list.filter !== "all") return `<div class="empty">${emptyArt("filter")}<h3>没有符合筛选条件的邮件</h3></div>`;
  const [t, d] = EMPTY[r.view] ?? EMPTY.all;
  const art = r.view === "inbox" ? inboxZero : emptyArt({ trash: "trash", spam: "shieldAlert", starred: "star", drafts: "draft", sent: "send", snoozed: "clock", label: "tag", archive: "archive" }[r.view] ?? "inbox");
  return `<div class="empty">${art}<h3>${t}</h3>${d ? `<p>${d}</p>` : ""}</div>`;
}

function skeleton() {
  return Array.from({ length: 8 }, () => `<div class="row skeleton"><span class="avatar sk"></span><div class="row-main"><i class="sk w40"></i><i class="sk w70"></i><i class="sk w90"></i></div></div>`).join("");
}

function participantsText(t) {
  const ps = t.participants || [];
  if (store.route.view === "sent") {
    const to = parseList(t.to_addrs);
    return "发给 " + (to.map((a) => displayName(a.name, a.address)).join("、") || "—");
  }
  if (!ps.length) return displayName(t.from_name, t.from_addr);
  const names = ps.map((p) => p.name);
  return names.length > 3 ? `${names[0]} … ${names.slice(-2).join("、")}` : names.join("、");
}

const DELIVERY_ICON = { delivered: ["checkCheck", "已送达", "ok"], bounced: ["alert", "退信", "bad"], rejected: ["ban", "被拒收", "bad"], failed: ["alert", "发送失败", "bad"] };

function labelChips(ids) {
  return (ids || [])
    .map((id) => store.labels.find((l) => l.id === id))
    .filter(Boolean)
    .map((l) => `<span class="tag label-tag" style="--lc:${esc(l.color)}"><span class="label-dot"></span>${esc(l.name)}</span>`)
    .join("");
}

// 收件 / 发件地址标签：圆点颜色与侧栏一致（地址设置了颜色就用地址颜色，否则用域名颜色）
function boxTag(mailbox, title) {
  const info = (store.addresses || []).find((a) => a.address === mailbox);
  const color = info?.color || avatarColor((mailbox || "").split("@")[1] || mailbox);
  return `<span class="tag tag-box" title="${esc(title)}"><span class="box-dot" style="--dc:${esc(color)}"></span>${esc(mailbox || "")}</span>`;
}

function rowHtml(t, focusable) {
  const L = store.list;
  const sel = L.selected.has(t.thread_id);
  const active = store.route.thread === t.thread_id;
  const tab = `tabindex="${focusable ? 0 : -1}"`;
  if (t.isDraft) {
    const to = (t.to || []).join("、");
    const sched = t.scheduledId;
    return `<div class="row draft ${active ? "active" : ""}" data-tid="${esc(t.thread_id)}" ${sched ? `data-sched="${esc(t.scheduledId)}"` : `data-draft="${esc(t.id)}"`} role="listitem" ${tab}>
      <div class="row-lead">${sched ? `<span class="avatar sched">${icon("calendarClock")}</span>` : avatar("草", "draft", "", { brand: false })}</div>
      <div class="row-main">
        <div class="row-top"><span class="row-from">${sched ? `<span class="sched-tag i18n ${t.status === "failed" ? "bad" : ""}">${t.status === "failed" ? "定时发送失败" : "定时 " + esc(fmtWhen(t.send_at))}</span>` : `<span class="draft-tag i18n">草稿</span>`}${to ? esc(to) : '<span class="i18n">（未填写收件人）</span>'}</span><time>${fmtListTime(t.updated_at)}</time></div>
        <div class="row-subject">${t.subject ? esc(t.subject) : '<span class="i18n">（无主题）</span>'}</div>
        <div class="row-bottom"><span class="row-snippet">${esc(t.error || (t.text || "").slice(0, 140))}</span>
          <span class="row-tags">${boxTag(t.from, "发件地址")}${t.attachments?.length ? `<span class="tag">${icon("paperclip")}${t.attachments.length}</span>` : ""}</span></div>
      </div>
      <div class="row-hover"><button class="icon-btn sm" data-draft-del title="${sched ? "取消定时发送" : "删除草稿"}" aria-label="删除">${icon(sched ? "x" : "trash")}</button></div>
    </div>`;
  }
  const isSent = t.folder === "sent";
  const fromName = isSent ? "我" : displayName(t.from_name, t.from_addr);
  const view = store.route.view;
  const starAct = t.any_star ? "unstar" : "star";
  const quick = (view === "trash" ? ["restore", "delete"] : view === "spam" ? ["notspam", "delete_spam"] : view === "snoozed" ? ["unsnooze", "trash", starAct] : view === "archive" ? ["unarchive", "trash", "snooze", starAct] : ["archive", "trash", "snooze", t.unread ? "read" : "unread", starAct])
    .map((a) => `<button class="icon-btn sm ${a === "unstar" ? "starred" : ""}" data-act="${a}" title="${ACTION_META[a].label}" aria-label="${ACTION_META[a].label}">${icon(ACTION_META[a].icon, a === "unstar" ? "filled" : "")}</button>`)
    .join("");
  const d = isSent && DELIVERY_ICON[t.delivery];
  return `<div class="row ${t.unread ? "unread" : ""} ${sel ? "selected" : ""} ${active ? "active" : ""}" data-tid="${esc(t.thread_id)}" role="listitem" ${tab}
      aria-label="${esc(`${t.unread ? "未读，" : ""}${participantsText(t)}，${t.subject || "无主题"}`)}">
    <div class="row-lead">
      ${avatar(fromName === "我" ? "我" : t.from_name, isSent ? t.mailbox : t.from_addr, "", { brand: !isSent })}
      <label class="check" title="选择"><input type="checkbox" ${sel ? "checked" : ""} aria-label="选择" tabindex="-1" /><span></span></label>
    </div>
    <div class="row-main">
      <div class="row-top">
        <span class="row-from">${esc(participantsText(t))}</span>${t.cnt > 1 ? `<span class="row-count">${t.cnt}</span>` : ""}
        <span class="row-icons">${d ? `<span class="dlv ${d[2]}" title="${d[1]}">${icon(d[0])}</span>` : ""}${t.any_att ? icon("paperclip") : ""}${t.any_star ? `<span class="row-star" title="已加星标">${icon("star", "filled")}</span>` : ""}</span>
        <time title="${new Date(t.created_at * 1000).toLocaleString("zh-CN")}">${view === "snoozed" && t.snooze_until ? esc(fmtWhen(t.snooze_until)) : fmtListTime(t.created_at)}</time>
      </div>
      <div class="row-subject">${t.subject ? esc(t.subject) : '<span class="i18n">（无主题）</span>'}</div>
      <div class="row-bottom"><span class="row-snippet">${esc(t.snippet || "")}</span>
        <span class="row-tags">${labelChips(t.labels)}${boxTag(t.mailbox, t.folder === "inbox" ? "收件地址" : "发件地址")}</span></div>
    </div>
    <div class="row-hover">${quick}</div>
  </div>`;
}

export function renderList() {
  const el = pane();
  if (!el) return;
  const L = store.list;
  const r = store.route;
  const acts = actionsFor(r.view);
  const nSel = L.selected.size;
  const allSel = nSel && nSel === L.threads.length;
  const focusId = r.thread && L.threads.some((t) => t.thread_id === r.thread) ? r.thread : L.threads[0]?.thread_id;

  let groups = "";
  if (L.loading && !L.threads.length) groups = skeleton();
  else if (!L.threads.length) groups = emptyState();
  else {
    let last = null;
    for (const t of L.threads) {
      const g = t.scheduledId ? "定时发送" : dateGroup(t.isDraft ? t.updated_at : t.created_at);
      if (g !== last) {
        groups += `<div class="group-head" role="presentation">${g}</div>`;
        last = g;
      }
      groups += rowHtml(t, t.thread_id === focusId);
    }
    if (L.next) groups += `<div class="list-more">${L.loading ? `${icon("loader", "spin")} 加载中…` : `<button class="btn ghost sm" data-more>加载更多</button>`}</div>`;
    else if (L.threads.length > 15) groups += `<div class="list-end">没有更多了</div>`;
  }

  const unreadInView = r.view === "inbox" ? store.stats.unread : 0;
  el.innerHTML = `
    <div class="list-head ${nSel ? "selecting" : ""}">
      ${
        acts.length
          ? `<label class="check head-check" title="全选"><input type="checkbox" class="sel-all" ${allSel ? "checked" : ""} ${L.threads.length ? "" : "disabled"} aria-label="全选" /><span class="${nSel && !allSel ? "partial" : ""}"></span></label>`
          : ""
      }
      ${
        nSel
          ? `<span class="sel-count">已选 ${nSel}</span><div class="bulk" role="toolbar" aria-label="批量操作">${acts
              .map((a) => `<button class="bulk-btn" data-bulk="${a}" title="${ACTION_META[a].label}">${icon(ACTION_META[a].icon)}<span>${ACTION_META[a].label}</span></button>`)
              .join("")}</div>`
          : `<h1 class="list-title"><span>${esc(viewTitle())}</span>${unreadInView ? `<span class="title-count">${unreadInView} 封未读</span>` : ""}</h1>
             <div class="list-tools">
               ${["trash", "spam"].includes(r.view) && L.threads.length ? `<button class="btn ghost sm danger" data-empty>清空</button>` : ""}
               ${["inbox", "box", "domain", "label"].includes(r.view) && L.threads.some((t) => t.unread) ? `<button class="icon-btn" data-read-all title="全部标为已读" aria-label="全部标为已读">${icon("checkCheck")}</button>` : ""}
               <button class="icon-btn" data-refresh title="刷新" aria-label="刷新">${icon("refresh", L.loading ? "spin" : "")}</button>
             </div>`
      }
    </div>
    ${
      r.view !== "drafts"
        ? `<div class="filters" role="tablist">${[
            ["all", "全部"],
            ["unread", "未读"],
            ["starred", "星标"],
            ["attachments", "有附件"],
          ]
            .map(([k, label]) => `<button class="filter ${L.filter === k ? "on" : ""}" data-filter="${k}" role="tab" aria-selected="${L.filter === k}">${label}</button>`)
            .join("")}${L.q ? `<span class="search-chip">${icon("search")}“${esc(L.q)}”<button data-clear-q aria-label="清除搜索">${icon("x")}</button></span>` : ""}</div>`
        : ""
    }
    ${["trash", "spam"].includes(r.view) && L.threads.length ? `<div class="notice info sm list-notice">${icon("info")}<span>${r.view === "trash" ? "垃圾箱" : "垃圾邮件"}中的邮件会在 30 天后自动永久删除。</span></div>` : ""}
    <div class="ptr" aria-hidden="true">${icon("refresh")}</div>
    <div class="list-body" role="list" aria-label="${esc(viewTitle())}">${groups}</div>`;
  bindList(el);
}

function bindList(el) {
  const L = store.list;
  const r = store.route;
  el.querySelector("[data-refresh]")?.addEventListener("click", () => loadList());
  el.querySelector("[data-more]")?.addEventListener("click", () => loadList({ reset: false }));
  el.querySelector("[data-clear-q]")?.addEventListener("click", () => {
    L.q = "";
    const s = $("#search");
    if (s) s.value = "";
    loadList();
  });
  el.querySelector("[data-read-all]")?.addEventListener("click", () => threadAction(L.threads.filter((t) => t.unread).map((t) => t.thread_id), "read"));
  el.querySelector("[data-empty]")?.addEventListener("click", () => emptyFolder(r.view));
  el.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        L.filter = b.dataset.filter;
        loadList();
      }),
  );
  el.querySelector(".sel-all")?.addEventListener("change", (e) => {
    if (e.target.checked) L.threads.forEach((t) => L.selected.add(t.thread_id));
    else L.selected.clear();
    renderList();
  });
  el.querySelectorAll("[data-bulk]").forEach((b) => (b.onclick = () => bulk(b.dataset.bulk, b)));

  const body = el.querySelector(".list-body");
  body.addEventListener("click", (e) => onRowClick(e));
  body.addEventListener("keydown", onListKey);
  body.addEventListener(
    "scroll",
    () => {
      if (L.next && !L.loading && body.scrollTop + body.clientHeight > body.scrollHeight - 300) {
        L.loading = true;
        loadList({ reset: false });
      }
    },
    { passive: true },
  );
  enableTouch(el, body);
}

async function onRowClick(e) {
  const L = store.list;
  const r = store.route;
  const row = e.target.closest(".row");
  if (!row || row.classList.contains("skeleton") || row.dataset.swiped) return;
  const tid = row.dataset.tid;
  if (row.classList.contains("draft")) {
    const d = L.threads.find((t) => t.thread_id === tid);
    if (e.target.closest("[data-draft-del]")) {
      e.stopPropagation();
      if (d.scheduledId) {
        const res = await api(`/scheduled/${d.scheduledId}`, { method: "DELETE" }).catch(toastError);
        if (res) toast("已取消定时发送，邮件内容已放回草稿", { action: { label: "编辑", onClick: () => openComposer({ ...res.payload, draftId: res.payload.draftId }) } });
        if (res?.payload) await api(`/drafts/${res.payload.draftId || crypto.randomUUID()}`, { method: "PUT", body: res.payload }).catch(() => {});
      } else {
        await api(`/drafts/${d.id}`, { method: "DELETE" }).catch(toastError);
        toast("草稿已删除");
      }
      emit("drafts:changed");
      return;
    }
    if (d.scheduledId) {
      const ok = await confirmDialog({ title: "编辑定时发送的邮件？", message: "将取消这次定时发送，打开邮件供你修改。", confirmLabel: "编辑" });
      if (!ok) return;
      const res = await api(`/scheduled/${d.scheduledId}`, { method: "DELETE" }).catch(toastError);
      if (res?.payload) openComposer(res.payload);
      emit("drafts:changed");
      return;
    }
    openComposer({ ...d, draftId: d.id });
    return;
  }
  if (e.target.closest(".check")) {
    e.preventDefault();
    L.selected.has(tid) ? L.selected.delete(tid) : L.selected.add(tid);
    renderList();
    return;
  }
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    if (act.dataset.act === "snooze") return snoozeMenu(act, [tid]);
    threadAction([tid], act.dataset.act);
    return;
  }
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    L.selected.has(tid) ? L.selected.delete(tid) : L.selected.add(tid);
    renderList();
    return;
  }
  navigate(r.view, r.arg, tid);
}

// 列表内的键盘操作：↑↓ 移动焦点，Enter 打开，空格选择
function onListKey(e) {
  const row = e.target.closest(".row");
  if (!row) return;
  const rows = [...document.querySelectorAll(".list-body .row:not(.skeleton)")];
  const i = rows.indexOf(row);
  const move = (j) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, j))];
    if (!next) return;
    rows.forEach((x) => (x.tabIndex = -1));
    next.tabIndex = 0;
    next.focus();
  };
  if (e.key === "ArrowDown") (e.preventDefault(), move(i + 1));
  else if (e.key === "ArrowUp") (e.preventDefault(), move(i - 1));
  else if (e.key === "Home") (e.preventDefault(), move(0));
  else if (e.key === "End") (e.preventDefault(), move(rows.length - 1));
  else if (e.key === "Enter") (e.preventDefault(), row.click());
  else if (e.key === " " && !row.classList.contains("draft")) {
    e.preventDefault();
    const L = store.list;
    const tid = row.dataset.tid;
    L.selected.has(tid) ? L.selected.delete(tid) : L.selected.add(tid);
    renderList();
    document.querySelector(`.row[data-tid="${CSS.escape(tid)}"]`)?.focus();
  }
}

// ---------- 手机手势：左右滑动归档/删除，下拉刷新 ----------
function enableTouch(el, body) {
  if (!matchMedia("(pointer: coarse)").matches) return;
  const view = store.route.view;
  const right = view === "trash" ? "restore" : view === "spam" ? "notspam" : view === "archive" ? "unarchive" : view === "sent" || view === "drafts" ? null : "archive";
  const left = view === "trash" || view === "spam" || view === "drafts" ? null : "trash";
  let sx = 0, sy = 0, row = null, dx = 0, mode = null;
  body.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    dx = 0;
    mode = null;
    row = e.target.closest(".row:not(.draft):not(.skeleton)");
  }, { passive: true });
  body.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    const mx = t.clientX - sx;
    const my = t.clientY - sy;
    if (!mode) mode = Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) ? "swipe" : Math.abs(my) > 12 ? (body.scrollTop <= 0 && my > 0 ? "pull" : "scroll") : null;
    if (mode === "swipe" && row && ((mx > 0 && right) || (mx < 0 && left))) {
      dx = mx;
      row.style.transform = `translateX(${dx}px)`;
      row.dataset.swipe = dx > 0 ? "right" : "left";
      row.classList.toggle("swipe-armed", Math.abs(dx) > 90);
    } else if (mode === "pull") {
      const p = el.querySelector(".ptr");
      const d = Math.min(80, my * 0.5);
      p.style.transform = `translateY(${d}px) rotate(${d * 4}deg)`;
      p.classList.toggle("armed", d > 55);
      p.style.opacity = String(Math.min(1, d / 55));
    }
  }, { passive: true });
  body.addEventListener("touchend", () => {
    if (mode === "swipe" && row) {
      const r0 = row;
      if (Math.abs(dx) > 90) {
        r0.dataset.swiped = "1";
        r0.style.transition = "transform .18s";
        r0.style.transform = `translateX(${dx > 0 ? "100%" : "-100%"})`;
        setTimeout(() => threadAction([r0.dataset.tid], dx > 0 ? right : left), 160);
      } else {
        r0.style.transition = "transform .18s";
        r0.style.transform = "";
        setTimeout(() => ((r0.style.transition = ""), delete r0.dataset.swipe, r0.classList.remove("swipe-armed")), 200);
      }
    } else if (mode === "pull") {
      const p = el.querySelector(".ptr");
      if (p.classList.contains("armed")) loadList({ silent: true }).then(() => emit("stats:refresh"));
      p.style.transform = "";
      p.style.opacity = "0";
      p.classList.remove("armed");
    }
    row = null;
    mode = null;
  });
}

// ---------- 批量 / 菜单 ----------
async function bulk(action, anchor) {
  const ids = [...store.list.selected];
  if (action === "label") return labelEditor(anchor, ids, [], () => loadList({ silent: true }));
  if (action === "snooze") return snoozeMenu(anchor, ids);
  if (action === "delete_spam") return threadAction(ids, "spam_delete");
  if (action === "star") {
    const allStar = ids.every((id) => store.list.threads.find((t) => t.thread_id === id)?.any_star);
    return threadAction(ids, allStar ? "unstar" : "star");
  }
  threadAction(ids, action);
}

export function snoozeMenu(anchor, tids) {
  menu(anchor, [
    { header: "提醒我的时间" },
    ...timePresets("snooze").map((p) => ({ label: `${p.label} · ${p.hint}`, icon: "clock", onClick: () => threadAction(tids, "snooze", { until: p.ts }) })),
    "-",
    {
      label: "选择日期和时间…",
      icon: "calendarClock",
      onClick: async () => {
        const ts = await pickDateTime({ title: "稍后提醒", confirmLabel: "设置提醒" });
        if (ts) threadAction(tids, "snooze", { until: ts });
      },
    },
  ]);
}

export async function createLabel() {
  const colors = ["#2f7bff", "#7c5cff", "#e5484d", "#f5a623", "#12a150", "#0ea5b7", "#d6409f", "#6b7280"];
  return new Promise((resolve) => {
    let picked = colors[0];
    let result = null;
    const m = modal({
      title: "新建标签",
      body: `<label class="field-label">名称</label><input class="input" autofocus maxlength="40" placeholder="例如：客户、发票、待处理" />
        <label class="field-label">颜色</label><div class="color-row">${colors.map((c, i) => `<button type="button" class="color-dot ${i === 0 ? "on" : ""}" data-c="${c}" style="--lc:${c}" aria-label="${c}"></button>`).join("")}</div>`,
      actions: [
        { label: "取消" },
        {
          label: "创建",
          kind: "primary",
          onClick: async () => {
            const name = m.body.querySelector("input").value.trim();
            if (!name) throw new Error("请填写标签名称");
            // 同名标签直接复用，避免出现两个一样的
            const same = store.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
            if (same) {
              result = same.id;
              return;
            }
            const id = crypto.randomUUID();
            await api(`/labels/${id}`, { method: "PUT", body: { name, color: picked } });
            store.labels = await api("/labels");
            result = id;
            emit("labels:changed");
          },
        },
      ],
      onClose: () => resolve(result),
    });
    m.body.querySelectorAll(".color-dot").forEach(
      (b) =>
        (b.onclick = () => {
          picked = b.dataset.c;
          m.body.querySelectorAll(".color-dot").forEach((x) => x.classList.toggle("on", x === b));
        }),
    );
  });
}

export function labelEditor(anchor, tids, selected, onChange) {
  const current = new Set(selected);
  labelMenu(
    anchor,
    store.labels,
    [...current],
    async (id, on) => {
      on ? current.add(id) : current.delete(id);
      await threadAction(tids, on ? "label" : "unlabel", { labelId: id, silent: true });
      onChange?.([...current]);
    },
    async () => {
      const id = await createLabel();
      if (id) {
        await threadAction(tids, "label", { labelId: id, silent: true });
        current.add(id);
        onChange?.([...current]);
      }
    },
  );
}

async function emptyFolder(view) {
  const which = view === "spam" ? "spam" : "trash";
  if (!(await confirmDialog({ title: `清空${which === "spam" ? "垃圾邮件" : "垃圾箱"}？`, message: "里面的所有邮件将被永久删除，无法恢复。", confirmLabel: "永久删除", danger: true }))) return;
  const t = toast("正在删除…", { type: "loading", duration: 0 });
  let total = 0;
  try {
    // 后端每次最多删 200 封，循环直到删完
    for (let i = 0; i < 200; i++) {
      const res = await api("/trash/empty", { body: { which } });
      total += res.deleted;
      t.update(`正在删除…已删除 ${total} 封`);
      if (!res.remaining || !res.deleted) break;
    }
    t.close();
    toast(`已永久删除 ${total} 封邮件`, { type: "success" });
    emit("mail:changed");
  } catch (e) {
    t.close();
    toastError(e);
  }
}

// 操作后是否应从当前列表移除
function removesFromView(action, view) {
  if (action === "trash") return view !== "trash";
  if (["restore", "delete"].includes(action)) return view === "trash";
  if (action === "spam") return view !== "spam";
  if (["notspam", "spam_delete"].includes(action)) return view === "spam";
  if (action === "archive") return ["inbox", "snoozed"].includes(view);
  if (action === "unarchive") return view === "archive";
  if (action === "unstar") return view === "starred";
  if (action === "snooze") return ["inbox", "archive", "box", "domain", "label", "all"].includes(view);
  if (action === "unsnooze") return view === "snoozed";
  return false;
}

const UNDO = { archive: "unarchive", unarchive: "archive", trash: "restore", restore: "trash", star: "unstar", unstar: "star", read: "unread", unread: "read", spam: "notspam", notspam: "spam", snooze: "unsnooze" };
const DONE_TEXT = {
  archive: "已归档", unarchive: "已移回收件箱", trash: "已移到垃圾箱", restore: "已恢复", delete: "已永久删除", spam_delete: "已永久删除",
  read: "已标为已读", unread: "已标为未读", star: "已加星标", unstar: "已取消星标", spam: "已移到垃圾邮件", notspam: "已移回收件箱",
  snooze: "已设置稍后提醒", unsnooze: "已取消提醒", label: "已添加标签", unlabel: "已移除标签",
};

export async function threadAction(tids, action, { silent = false, until, labelId, blockSender } = {}) {
  if (!tids.length) return;
  const L = store.list;
  const view = store.route.view;
  const apiAction = action === "spam_delete" ? "delete" : action;
  if ((action === "delete" || action === "spam_delete") && !(await confirmDialog({ title: "永久删除？", message: `${tids.length} 个会话将被永久删除，无法恢复。`, confirmLabel: "永久删除", danger: true }))) return;

  // 垃圾邮件里的"永久删除"需要先把它们移到垃圾箱，后端只彻底删除垃圾箱中的邮件
  const removed = removesFromView(action, view);
  const before = L.threads;
  if (removed) L.threads = L.threads.filter((t) => !tids.includes(t.thread_id));
  else
    L.threads = L.threads.map((t) => {
      if (!tids.includes(t.thread_id)) return t;
      if (action === "read") return { ...t, unread: 0 };
      if (action === "unread") return { ...t, unread: Math.max(1, t.unread) };
      if (action === "star") return { ...t, any_star: 1 };
      if (action === "unstar") return { ...t, any_star: 0 };
      if (action === "label") return { ...t, labels: [...new Set([...(t.labels || []), labelId])] };
      if (action === "unlabel") return { ...t, labels: (t.labels || []).filter((x) => x !== labelId) };
      return t;
    });
  tids.forEach((t) => L.selected.delete(t));
  renderList();
  if (removed && tids.includes(store.route.thread)) navigate(view, store.route.arg, null);

  try {
    if (action === "spam_delete") await api("/threads/action", { body: { threadIds: tids, action: "trash" } });
    await api("/threads/action", { body: { threadIds: tids, action: apiAction, until, labelId, blockSender } });
    emit("stats:refresh");
    if (!silent && !["read", "star", "unstar", "label", "unlabel"].includes(action)) {
      const undo = UNDO[action];
      const extra = action === "snooze" && until ? `（${fmtWhen(until)}）` : tids.length > 1 ? `（${tids.length} 个会话）` : "";
      toast(`${DONE_TEXT[action]}${extra}`, {
        action: undo
          ? {
              label: "撤销",
              onClick: async () => {
                await api("/threads/action", { body: { threadIds: tids, action: undo } }).catch(toastError);
                emit("mail:changed");
              },
            }
          : undefined,
      });
    }
  } catch (e) {
    L.threads = before;
    renderList();
    toastError(e);
  }
}

export function moveSelection(delta) {
  const L = store.list;
  const r = store.route;
  if (!L.threads.length) return;
  const i = L.threads.findIndex((t) => t.thread_id === r.thread);
  const next = L.threads[Math.max(0, Math.min(L.threads.length - 1, i + delta))];
  if (next?.isDraft) return;
  if (next) {
    navigate(r.view, r.arg, next.thread_id);
    requestAnimationFrame(() => $(`.row[data-tid="${CSS.escape(next.thread_id)}"]`)?.scrollIntoView({ block: "nearest" }));
  }
}

export { h };
