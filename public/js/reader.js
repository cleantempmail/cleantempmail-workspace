// 阅读视图：会话卡片、HTML 正文（沙箱 iframe）、发件人验证、垃圾邮件、投递状态、退订、标签、稍后提醒、AI
import { api } from "./api.js";
import { emptyArt } from "./art.js";
import { openComposer, reattachInline, replyPrefill } from "./compose.js";
import { icon } from "./icons.js";
import { labelEditor, snoozeMenu, threadAction } from "./list.js";
import { emit, isAdmin, navigate, store } from "./store.js";
import { confirmDialog, menu, toast, toastError } from "./ui.js";
import { $, addrText, avatar, displayName, esc, fileKind, fmtFull, fmtRelative, fmtSize, fmtWhen, h, lang, parseList, renderPlainText } from "./util.js";

const pane = () => $(".reader-pane");
let loadSeq = 0;

// ---- 预取：鼠标悬停 / 按下 / 触摸列表行时提前取会话和正文，点开时基本不用等 ----
// 会话用 peek=1 取（不会标为已读），正文 HTML 进浏览器缓存，iframe 打开时直接命中
const prefetched = new Map();
const htmlUrl = (id, images) => `/api/messages/${encodeURIComponent(id)}/html?images=${images}`;

export function prefetchThread(t) {
  if (!t || t.isDraft || prefetched.has(t.thread_id)) return;
  const trash = store.route.view === "trash" ? "1" : "0";
  const promise = api(`/threads/${encodeURIComponent(t.thread_id)}?trash=${trash}&peek=1`);
  promise.catch(() => prefetched.delete(t.thread_id));
  prefetched.set(t.thread_id, { at: Date.now(), promise });
  // 最后一封的正文（打开时默认展开的就是它）
  if (t.id) fetch(htmlUrl(t.id, trusted({ from_addr: t.from_addr }) ? 1 : 0), { credentials: "same-origin" }).catch(() => {});
  // 只保留最近的几个
  if (prefetched.size > 12) prefetched.delete(prefetched.keys().next().value);
}

// 对会话做了操作（归档、标星等）后，之前预取的数据就过期了
export function forgetPrefetched(tids) {
  for (const t of tids) prefetched.delete(t);
}

function takePrefetched(tid) {
  const p = prefetched.get(tid);
  prefetched.delete(tid);
  return p && Date.now() - p.at < 20000 ? p.promise : null;
}

export async function loadThread(tid) {
  const seq = ++loadSeq;
  const early = takePrefetched(tid);
  store.thread = { threadId: tid, loading: true, messages: [] };
  renderReader();
  try {
    const trash = store.route.view === "trash" ? "1" : "0";
    const data = (early && (await early.catch(() => null))) || (await api(`/threads/${encodeURIComponent(tid)}?trash=${trash}`));
    if (seq !== loadSeq) return;
    store.thread = data;
    const row = store.list.threads.find((t) => t.thread_id === tid);
    // 预取的数据没有标已读：这里补标
    if (early && data.messages.some((m) => m.folder === "inbox" && !m.is_read)) {
      api("/threads/action", { body: { threadIds: [tid], action: "read" } }).then(() => emit("stats:refresh"), () => {});
    }
    if (row?.unread) {
      row.unread = 0;
      $(`.row[data-tid="${CSS.escape(tid)}"]`)?.classList.remove("unread");
      if (!early) setTimeout(() => emit("stats:refresh"), 300);
    }
    renderReader();
    // 顺便预取列表里的下一封（j / 下一封 时不用等）
    const i = store.list.threads.findIndex((t) => t.thread_id === tid);
    if (i >= 0) prefetchThread(store.list.threads[i + 1]);
  } catch (e) {
    if (seq !== loadSeq) return;
    store.thread = { threadId: tid, error: e.message, messages: [] };
    renderReader();
  }
}

export function clearThread() {
  loadSeq++;
  store.thread = null;
  renderReader();
}

function placeholder() {
  const n = store.route.view === "inbox" ? store.stats.unread : 0;
  return `<div class="reader-empty">
    ${emptyArt("mailOpen")}
    <h3>${n ? `${n} 封未读邮件` : "选择一封邮件开始阅读"}</h3>
    <p>按 <kbd>j</kbd> / <kbd>k</kbd> 上下切换，<kbd>c</kbd> 写邮件，<kbd>?</kbd> 查看全部快捷键</p>
  </div>`;
}

function senderOf(m) {
  return m.folder === "sent" ? { name: m.from_name || "我", address: m.from_addr } : { name: m.from_name, address: m.from_addr };
}

function trusted(m) {
  const s = store.settings;
  if (!s) return false;
  return s.remoteImages === "always" || s.trustedSenders?.includes(m.from_addr);
}

// 发件人验证：Cloudflare 收信时做的 SPF / DKIM / DMARC 检查
function authBadge(m) {
  const a = m.auth;
  if (m.folder !== "inbox" || !a || (!a.spf && !a.dkim && !a.dmarc)) return "";
  const fromDomain = (m.from_addr.split("@")[1] || "").toLowerCase();
  const aligned = a.dkim === "pass" && a.dkimDomain && (fromDomain === a.dkimDomain || fromDomain.endsWith("." + a.dkimDomain));
  const lines = `SPF：${a.spf ?? "—"}　DKIM：${a.dkim ?? "—"}${a.dkimDomain ? `（${a.dkimDomain}）` : ""}　DMARC：${a.dmarc ?? "—"}${a.score !== undefined ? `　评分：${a.score}` : ""}`;
  if (a.dmarc === "pass" || aligned) return `<span class="auth-badge ok" title="${esc(lines)}">${icon("shieldCheck")}已验证</span>`;
  if (a.dmarc === "fail" || (a.spf === "fail" && a.dkim !== "pass")) return `<span class="auth-badge bad" title="${esc(lines)}">${icon("shieldAlert")}未通过验证</span>`;
  return "";
}

const DELIVERY = {
  sent: ["已发出", "muted", "send"],
  delivered: ["已送达", "ok", "checkCheck"],
  bounced: ["退信", "bad", "alert"],
  rejected: ["被拒收", "bad", "ban"],
  failed: ["发送失败", "bad", "alert"],
};
function deliveryChip(m) {
  if (m.folder !== "sent" || !m.delivery_status) return "";
  const [label, cls, ic] = DELIVERY[m.delivery_status] ?? DELIVERY.sent;
  return `<span class="delivery ${cls}" title="${esc(m.delivery_detail || label)}">${icon(ic)}${label}</span>`;
}

function messageCard(m, expanded) {
  const from = senderOf(m);
  const to = parseList(m.to_addrs);
  const cc = parseList(m.cc_addrs);
  const bcc = parseList(m.bcc_addrs);
  const recips = [...to, ...cc].map((a) => displayName(a.name, a.address)).join("、");
  const atts = (m.attachments || []).filter((a) => !a.inline);
  const bad = m.auth?.dmarc === "fail";
  return `<article class="msg ${expanded ? "expanded" : "collapsed"} ${m.folder === "sent" ? "from-me" : ""} ${m.is_bounce ? "is-bounce" : ""}" data-id="${esc(m.id)}">
    <header class="msg-head">
      ${avatar(from.name, from.address, "md", { brand: m.folder !== "sent" && m.auth?.dmarc === "pass" })}
      <div class="msg-who">
        <div class="msg-line1">
          <span class="msg-name">${esc(displayName(from.name, from.address))}</span>
          <span class="msg-addr">&lt;${esc(from.address)}&gt;</span>
          ${authBadge(m)}${deliveryChip(m)}${m.is_bounce ? `<span class="delivery bad">${icon("alert")}退信通知</span>` : ""}
        </div>
        <div class="msg-line2 when-expanded">
          <button class="link-btn msg-details-btn" data-details aria-expanded="false">发给 ${esc(recips || "—")}${icon("chevronDown")}</button>
        </div>
        <div class="msg-line2 when-collapsed msg-snippet">${esc(m.snippet || "")}</div>
      </div>
      <div class="msg-side">
        ${atts.length ? `<span class="msg-att-ind" title="${atts.length} 个附件">${icon("paperclip")}</span>` : ""}
        <time title="${esc(fmtFull(m.created_at))}">${esc(fmtRelative(m.created_at))}</time>
        <button class="icon-btn sm when-expanded star-btn ${m.starred ? "on" : ""}" data-msg-act="${m.starred ? "unstar" : "star"}" title="星标" aria-label="星标">${icon("star", m.starred ? "filled" : "")}</button>
        <button class="icon-btn sm when-expanded" data-reply="reply" title="回复" aria-label="回复">${icon("reply")}</button>
        <button class="icon-btn sm when-expanded" data-more title="更多" aria-label="更多操作">${icon("more")}</button>
      </div>
    </header>
    <div class="msg-details" hidden>
      <dl>
        <dt>发件人</dt><dd>${esc(addrText(from))}</dd>
        ${to.length ? `<dt>收件人</dt><dd>${esc(to.map(addrText).join(", "))}</dd>` : ""}
        ${cc.length ? `<dt>抄送</dt><dd>${esc(cc.map(addrText).join(", "))}</dd>` : ""}
        ${bcc.length ? `<dt>密送</dt><dd>${esc(bcc.map(addrText).join(", "))}</dd>` : ""}
        <dt>时间</dt><dd>${esc(fmtFull(m.created_at))}</dd>
        <dt>${m.folder === "sent" ? "发件地址" : "收件地址"}</dt><dd><span class="tag tag-in">${esc(m.mailbox)}</span></dd>
        ${m.provider ? `<dt>发送服务</dt><dd>${m.provider === "cloudflare" ? "Cloudflare Email Sending" : m.provider === "resend" ? "Resend" : esc(m.provider)}</dd>` : ""}
        ${m.delivery_status ? `<dt>投递状态</dt><dd>${esc((DELIVERY[m.delivery_status] ?? DELIVERY.sent)[0])}${m.delivery_detail ? `：${esc(m.delivery_detail)}` : ""}</dd>` : ""}
        ${m.auth && (m.auth.spf || m.auth.dkim || m.auth.dmarc) ? `<dt>验证</dt><dd>SPF ${esc(m.auth.spf ?? "—")} · DKIM ${esc(m.auth.dkim ?? "—")} · DMARC ${esc(m.auth.dmarc ?? "—")}${m.auth.score !== undefined ? ` · 评分 ${esc(m.auth.score)}` : ""}</dd>` : ""}
        ${m.reply_to ? `<dt>回复到</dt><dd>${esc(m.reply_to)}</dd>` : ""}
      </dl>
    </div>
    ${expanded && bad ? `<div class="msg-warn">${icon("shieldAlert")}<span>发件人身份验证失败：这封邮件可能是冒充 <b>${esc(m.from_addr.split("@")[1])}</b> 的钓鱼邮件，请不要点击链接或提供密码。</span></div>` : ""}
    ${expanded && m.parse_error ? `<div class="msg-warn soft">${icon("info")}<span>这封邮件的格式不标准，只能显示部分内容。可以在「更多」里下载原始邮件查看。</span></div>` : ""}
    <div class="msg-ai" hidden></div>
    <div class="msg-body">${expanded ? bodyHtml(m) : ""}</div>
    ${expanded && atts.length ? attachmentsHtml(m, atts) : ""}
  </article>`;
}

function bodyHtml(m) {
  if (m.hasHtml) {
    const images = trusted(m) ? 1 : 0;
    return `<div class="remote-banner i18n" hidden></div>
      <div class="html-frame"><iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"
        src="/api/messages/${encodeURIComponent(m.id)}/html?images=${images}" title="邮件正文"></iframe></div>
      <button class="quote-toggle i18n" hidden aria-label="显示引用内容">${icon("moreH")}</button>`;
  }
  const { main, quoted } = renderPlainText(m.text);
  return `<div class="text-body">${main || '<span class="muted">（无正文）</span>'}</div>${quoted ? `<button class="quote-toggle i18n" aria-label="显示引用内容">${icon("moreH")}</button><div class="text-body quoted" hidden>${quoted}</div>` : ""}`;
}

function attachmentsHtml(m, atts) {
  return `<div class="msg-atts">
    <div class="msg-atts-head">${icon("paperclip")}${atts.length} 个附件 · ${fmtSize(atts.reduce((s, a) => s + a.size, 0))}</div>
    <div class="att-grid">${atts
      .map((a) => {
        const k = fileKind(a.mimeType, a.filename);
        const url = `/api/messages/${encodeURIComponent(m.id)}/attachments/${a.index}`;
        const isImg = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(a.mimeType);
        // 收信时没能保存的附件：只显示名称，提示从原始邮件里取
        if (a.missing) {
          return `<div class="att-card missing" data-kind="${k.kind}">
            <span class="att-preview"><span class="ficon lg f-${k.kind}">${esc(k.label)}</span></span>
            <div class="att-info"><span class="att-name" title="${esc(a.filename)}">${esc(a.filename)}</span><span class="att-size i18n">没能保存，请下载原始邮件</span></div>
          </div>`;
        }
        return `<div class="att-card" data-index="${a.index}" data-kind="${k.kind}">
          <button class="att-preview" data-preview="${a.index}" title="${isImg || k.kind === "pdf" ? "预览" : "下载"}" aria-label="${esc(a.filename)}">
            ${isImg ? `<img src="${url}?inline=1" alt="" loading="lazy" />` : `<span class="ficon lg f-${k.kind}">${esc(k.label)}</span>`}
          </button>
          <div class="att-info"><span class="att-name" title="${esc(a.filename)}">${esc(a.filename)}</span><span class="att-size">${fmtSize(a.size)}</span></div>
          <a class="icon-btn sm att-dl" href="${url}" download title="下载" aria-label="下载 ${esc(a.filename)}">${icon("download")}</a>
        </div>`;
      })
      .join("")}</div></div>`;
}

function threadTagsHtml(t) {
  const msgs = t.messages;
  const boxes = [...new Set(msgs.map((m) => m.mailbox))];
  const labels = (t.labels || []).map((id) => store.labels.find((l) => l.id === id)).filter(Boolean);
  return `${boxes.map((b) => `<a class="tag tag-in" href="#/box/${encodeURIComponent(b)}">${icon("at")}${esc(b)}</a>`).join("")}
    ${labels.map((l) => `<span class="tag label-tag" style="--lc:${esc(l.color)}"><span class="label-dot"></span><span class="u">${esc(l.name)}</span><button data-unlabel="${esc(l.id)}" aria-label="移除标签">${icon("x")}</button></span>`).join("")}
    ${t.snooze_until && t.snooze_until * 1000 > Date.now() ? `<span class="tag snooze-tag">${icon("clock")}${esc(fmtWhen(t.snooze_until))} 提醒<button data-unsnooze aria-label="取消提醒">${icon("x")}</button></span>` : ""}
    ${msgs.length > 1 ? `<span class="tag">${msgs.length} 封邮件</span>` : ""}`;
}

// 星标、标签、提醒这类操作只更新会话头部和星标按钮，不重建邮件正文：
// 避免 iframe 重新加载，滚动位置、手动展开的邮件和"显示图片"的选择都保留
function patchReader() {
  const el = pane();
  const t = store.thread;
  if (!el || !t?.messages) return;
  const anyStar = t.messages.some((m) => m.starred);
  const star = el.querySelector(".reader-toolbar .star-btn");
  if (star) {
    star.classList.toggle("on", anyStar);
    star.dataset.threadAct = anyStar ? "unstar" : "star";
    star.innerHTML = icon("star", anyStar ? "filled" : "");
  }
  el.querySelectorAll(".msg[data-id]").forEach((card) => {
    const m = t.messages.find((x) => x.id === card.dataset.id);
    const b = card.querySelector("[data-msg-act]");
    if (!m || !b) return;
    b.classList.toggle("on", Boolean(m.starred));
    b.dataset.msgAct = m.starred ? "unstar" : "star";
    b.innerHTML = icon("star", m.starred ? "filled" : "");
  });
  const tags = el.querySelector(".thread-tags");
  if (tags) {
    tags.innerHTML = threadTagsHtml(t);
    bindTags(el);
  }
}

function bindTags(el) {
  const t = store.thread;
  el.querySelectorAll("[data-unlabel]").forEach(
    (b) =>
      (b.onclick = async () => {
        await threadAction([t.threadId], "unlabel", { labelId: b.dataset.unlabel, silent: true });
        t.labels = (t.labels || []).filter((x) => x !== b.dataset.unlabel);
        patchReader();
      }),
  );
  el.querySelector("[data-unsnooze]")?.addEventListener("click", async () => {
    await threadAction([t.threadId], "unsnooze", { silent: true });
    t.snooze_until = null;
    patchReader();
  });
}

export function renderReader() {
  const el = pane();
  if (!el) return;
  const t = store.thread;
  document.querySelector(".workspace")?.classList.toggle("reading", Boolean(store.route.thread));
  if (!t) {
    el.innerHTML = placeholder();
    return;
  }
  if (t.loading) {
    el.innerHTML = `<div class="reader-loading">${icon("loader", "spin")}</div>`;
    return;
  }
  if (t.error) {
    el.innerHTML = `<div class="reader-empty">${icon("alert", "empty-icon")}<h3>${esc(t.error)}</h3><button class="btn" data-back>${icon("back")}返回列表</button></div>`;
    el.querySelector("[data-back]").onclick = () => navigate(store.route.view, store.route.arg, null);
    return;
  }
  const msgs = t.messages;
  const last = msgs[msgs.length - 1];
  const target = replyTarget(msgs);
  const subject = (msgs.find((m) => !m.is_bounce && m.subject) ?? last)?.subject || "（无主题）";
  const view = store.route.view;
  const inTrash = view === "trash";
  const anyStar = msgs.some((m) => m.starred);
  const inbox = msgs.filter((m) => m.folder === "inbox");
  const anyInbox = inbox.length > 0;
  const archived = anyInbox && inbox.every((m) => m.archived);
  const spam = inbox.some((m) => m.spam);
  const expandedIds = new Set([last?.id, ...inbox.filter((m) => !m.is_read).map((m) => m.id)]);
  const unsub = [...inbox].reverse().find((m) => m.list_unsub);

  const actions = inTrash
    ? [
        ["restore", "restore", "恢复"],
        ["delete", "trash", "永久删除"],
      ]
    : spam
      ? [
          ["notspam", "inbox", "不是垃圾邮件"],
          ["trash", "trash", "删除 (#)"],
        ]
      : [
          anyInbox ? (archived ? ["unarchive", "unarchive", "移回收件箱"] : ["archive", "archive", "归档 (e)"]) : null,
          ["trash", "trash", "删除 (#)"],
        ].filter(Boolean);
  const moreActs = !inTrash && !spam && anyInbox ? [["unread", "mail", "标为未读"], ["spam", "shieldAlert", "报告垃圾邮件"]] : [];

  el.innerHTML = `
    <div class="reader-toolbar" role="toolbar" aria-label="会话操作">
      <button class="icon-btn back-btn" data-back title="返回 (u)" aria-label="返回">${icon("back")}</button>
      ${actions.map(([a, ic, label]) => `<button class="icon-btn" data-thread-act="${a}" title="${label}" aria-label="${label}">${icon(ic)}</button>`).join("")}
      ${!inTrash && !spam ? `<span class="tb-sep"></span>
        <button class="icon-btn" data-snooze title="稍后提醒 (b)" aria-label="稍后提醒">${icon("clock")}</button>
        <button class="icon-btn" data-labels title="标签 (l)" aria-label="标签">${icon("tag")}</button>` : ""}
      <span class="tb-spacer"></span>
      ${store.me.ai && !inTrash ? `<button class="btn ghost sm ai-btn" data-ai-summary title="AI 摘要">${icon("sparkles")}<span>摘要</span></button>` : ""}
      ${!inTrash ? `<button class="icon-btn star-btn ${anyStar ? "on" : ""}" data-thread-act="${anyStar ? "unstar" : "star"}" title="星标 (s)" aria-label="星标">${icon("star", anyStar ? "filled" : "")}</button>` : ""}
      <button class="icon-btn" data-thread-more title="更多" aria-label="更多">${icon("more")}</button>
    </div>
    <div class="reader-scroll">
      <div class="thread-head">
        <h1 class="thread-subject">${subject === "（无主题）" ? '<span class="i18n">（无主题）</span>' : esc(subject)}</h1>
        <div class="thread-tags">${threadTagsHtml(t)}</div>
      </div>
      ${spam ? `<div class="thread-banner spam">${icon("shieldAlert")}<div><b>这封邮件在垃圾邮件中</b><span>${spamReason(inbox.find((m) => m.spam))}</span></div><button class="btn sm" data-thread-act="notspam">不是垃圾邮件</button></div>` : ""}
      ${unsub && !spam ? `<div class="thread-banner info">${icon("bellOff")}<div><b>这是订阅邮件</b><span>来自 ${esc(unsub.from_name || unsub.from_addr)}，不想再收到可以一键退订。</span></div><button class="btn sm" data-unsub="${esc(unsub.id)}">退订</button></div>` : ""}
      <div class="ai-summary" hidden></div>
      <div class="thread-msgs">${msgs.map((m) => messageCard(m, expandedIds.has(m.id))).join("")}</div>
      ${
        !inTrash && last
          ? `<div class="reply-zone">
              <div class="reply-box">
                <button class="reply-prompt" data-reply-last="reply">${icon("reply")}<span>回复 ${esc(displayName(senderOf(target).name, senderOf(target).address))}…</span></button>
                <div class="reply-alt">
                  ${parseList(target.to_addrs).length + parseList(target.cc_addrs).length > 1 ? `<button class="btn ghost sm" data-reply-last="replyAll">${icon("replyAll")}全部回复</button>` : ""}
                  <button class="btn ghost sm" data-reply-last="forward">${icon("forward")}转发</button>
                </div>
              </div>
              <div class="reply-slot"></div>
              <p class="reply-hint">回复时自动使用 <b>${esc(target.mailbox)}</b> 发出</p>
            </div>`
          : ""
      }
    </div>`;
  bindReader(el, moreActs);
  reattachInline(el.querySelector(".reply-slot"), t.threadId);
  if (t.threadId !== lastShown) el.querySelector(".reader-scroll")?.classList.add("enter");
  lastShown = t.threadId;
}
let lastShown = null;

const replySlot = () => document.querySelector(".reader-pane .reply-slot");

function spamReason(m) {
  if (!m) return "";
  if (m.auth?.dmarc === "fail") return "原因：发件人身份验证（DMARC）失败";
  if (m.auth?.score !== undefined && store.settings?.spamScore && m.auth.score >= Number(store.settings.spamScore)) return `原因：Cloudflare 垃圾邮件评分 ${m.auth.score}`;
  return "原因：屏蔽名单、规则或 AI 判定";
}

function bindReader(el, moreActs = []) {
  const t = store.thread;
  const msgs = t.messages;
  const find = (id) => msgs.find((m) => m.id === id);
  const r = store.route;

  el.querySelector("[data-back]").onclick = () => navigate(r.view, r.arg, null);
  el.querySelectorAll("[data-thread-act]").forEach((b) => (b.onclick = () => threadActionFromReader(b.dataset.threadAct)));
  el.querySelector("[data-snooze]")?.addEventListener("click", (e) => snoozeMenu(e.currentTarget, [t.threadId]));
  el.querySelector("[data-labels]")?.addEventListener("click", (e) => labelEditor(e.currentTarget, [t.threadId], t.labels || [], (labels) => ((t.labels = labels), patchReader())));
  bindTags(el);
  el.querySelector("[data-unsub]")?.addEventListener("click", (e) => unsubscribe(find(e.currentTarget.dataset.unsub)));
  el.querySelector("[data-ai-summary]")?.addEventListener("click", (e) => aiSummary(el, e.currentTarget));
  el.querySelector("[data-thread-more]").onclick = (e) => {
    const lastIn = [...msgs].reverse().find((m) => m.folder === "inbox");
    menu(e.currentTarget, [
      ...moreActs.map(([a, ic, label]) => ({ label, icon: ic, onClick: () => threadActionFromReader(a) })),
      ...(moreActs.length ? ["-"] : []),
      { label: "全部展开", icon: "layers", onClick: () => el.querySelectorAll(".msg.collapsed").forEach((m) => expand(m)) },
      { label: "打印", icon: "printer", onClick: () => window.print() },
      lastIn ? { label: "下载原始邮件 (.eml)", icon: "code", onClick: () => (location.href = `/api/messages/${lastIn.id}/raw`) } : null,
      lastIn ? "-" : null,
      lastIn ? { label: `屏蔽 ${lastIn.from_addr}`, icon: "ban", onClick: () => blockSender(lastIn.from_addr) } : null,
      lastIn && isAdmin() ? { label: `停用地址 ${lastIn.mailbox}`, icon: "bellOff", onClick: () => disableAddress(lastIn.mailbox) } : null,
    ].filter(Boolean));
  };
  el.querySelectorAll("[data-reply-last]").forEach((b) => (b.onclick = () => openComposer(replyPrefill(replyTarget(msgs), b.dataset.replyLast), { mount: replySlot() })));

  el.querySelectorAll(".msg").forEach((card) => {
    const m = find(card.dataset.id);
    card.querySelector(".msg-head").addEventListener("click", (e) => {
      if (e.target.closest("button, a")) return;
      if (card.classList.contains("collapsed")) expand(card);
      else if (msgs.length > 1) collapse(card);
    });
    card.querySelector("[data-details]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const d = card.querySelector(".msg-details");
      d.hidden = !d.hidden;
      e.currentTarget.classList.toggle("open", !d.hidden);
      e.currentTarget.setAttribute("aria-expanded", String(!d.hidden));
    });
    card.querySelector("[data-reply]")?.addEventListener("click", () => openComposer(replyPrefill(m, "reply"), { mount: replySlot() }));
    card.querySelector("[data-msg-act]")?.addEventListener("click", (e) => messageAction(m, e.currentTarget.dataset.msgAct));
    card.querySelector("[data-more]")?.addEventListener("click", (e) => {
      const inbox = m.folder === "inbox";
      menu(e.currentTarget, [
        { label: "回复", icon: "reply", hint: "r", onClick: () => openComposer(replyPrefill(m, "reply"), { mount: replySlot() }) },
        { label: "全部回复", icon: "replyAll", hint: "a", onClick: () => openComposer(replyPrefill(m, "replyAll"), { mount: replySlot() }) },
        { label: "转发", icon: "forward", hint: "f", onClick: () => openComposer(replyPrefill(m, "forward"), { mount: replySlot() }) },
        store.me.ai ? { label: lang() === "en" ? "翻译成英文" : "翻译成中文", icon: "languages", onClick: () => translate(card, m) } : null,
        "-",
        inbox ? { label: m.is_read ? "从这里标为未读" : "标为已读", icon: "mail", onClick: () => messageAction(m, m.is_read ? "unread" : "read") } : null,
        inbox ? { label: "下载原始邮件 (.eml)", icon: "code", onClick: () => (location.href = `/api/messages/${m.id}/raw`) } : null,
        inbox && m.hasHtml && !trusted(m) ? { label: `总是显示 ${m.from_addr} 的图片`, icon: "image", onClick: () => trustSender(m.from_addr) } : null,
        inbox ? { label: `屏蔽 ${m.from_addr}`, icon: "ban", onClick: () => blockSender(m.from_addr) } : null,
        "-",
        store.route.view === "trash"
          ? { label: "永久删除这封邮件", icon: "trash", danger: true, onClick: () => messageAction(m, "delete") }
          : { label: "删除这封邮件", icon: "trash", danger: true, onClick: () => messageAction(m, "trash") },
      ].filter(Boolean));
    });
    if (card.classList.contains("expanded")) hydrateBody(card, m);
  });
}

function expand(card) {
  const m = store.thread.messages.find((x) => x.id === card.dataset.id);
  card.classList.replace("collapsed", "expanded");
  card.querySelector(".msg-body").innerHTML = bodyHtml(m);
  const atts = (m.attachments || []).filter((a) => !a.inline);
  if (atts.length && !card.querySelector(".msg-atts")) card.querySelector(".msg-body").insertAdjacentHTML("afterend", attachmentsHtml(m, atts));
  hydrateBody(card, m);
}
function collapse(card) {
  card.classList.replace("expanded", "collapsed");
  card.querySelector(".msg-body").innerHTML = "";
  card.querySelector(".msg-atts")?.remove();
  card.querySelector(".msg-details").hidden = true;
}

function hydrateBody(card, m) {
  const qt = card.querySelector(".quote-toggle");
  const quotedText = card.querySelector(".text-body.quoted");
  if (qt && quotedText) qt.onclick = () => (quotedText.hidden = !quotedText.hidden);

  card.querySelectorAll("[data-preview]").forEach(
    (b) =>
      (b.onclick = () => {
        const a = m.attachments.find((x) => x.index === Number(b.dataset.preview));
        const url = `/api/messages/${encodeURIComponent(m.id)}/attachments/${a.index}`;
        if (/^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(a.mimeType)) lightbox(m, a.index);
        else if (/pdf$/i.test(a.mimeType)) window.open(url + "?inline=1", "_blank", "noopener");
        else location.href = url;
      }),
  );

  const frame = card.querySelector("iframe");
  if (!frame) return;
  // 高度自适应：先压到 0 再量，否则 scrollHeight 至少等于当前高度，内容变短时缩不回来
  let fitting = false;
  const fit = () => {
    if (fitting) return;
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      fitting = true;
      const prev = frame.style.height;
      frame.style.height = "0px";
      const hgt = Math.max(40, doc.documentElement.scrollHeight);
      frame.style.height = prev;
      if (prev !== hgt + "px") frame.style.height = hgt + "px";
    } catch {
    } finally {
      requestAnimationFrame(() => (fitting = false));
    }
  };
  // 正文 HTML 一解析完就调整高度并显示，不等里面的图片全部加载完（营销邮件图片多，经隐私代理第一次加载可能要一两秒）
  const watch = () => {
    const prev = frame.contentDocument;
    let tries = 0;
    const tick = () => {
      const doc = frame.contentDocument;
      if (doc && doc !== prev && doc.URL !== "about:blank" && doc.body && doc.readyState !== "loading") return setup(doc);
      if (++tries < 400) setTimeout(tick, 25);
    };
    tick();
  };
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    setup(doc);
    fit();
  });
  const setup = (doc) => {
    if (doc.__cfmReady) return;
    doc.__cfmReady = true;
    fit();
    new ResizeObserver(fit).observe(doc.body);
    doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", fit));
    const quotes = doc.querySelectorAll(".gmail_quote, blockquote[type=cite], #divRplyFwdMsg, .yahoo_quoted, .cfm-quote");
    const toggle = card.querySelector(".quote-toggle");
    if (quotes.length && toggle && store.thread.messages.length > 1) {
      doc.body.classList.add("cfm-hide-quotes");
      toggle.hidden = false;
      toggle.onclick = () => {
        doc.body.classList.toggle("cfm-hide-quotes");
        fit();
      };
      fit();
    }
    // 防追踪统计：服务端改写正文时写在 body 上
    const ds = doc.body?.dataset ?? {};
    const trackers = Number(ds.cfmTrackers || 0);
    const links = Number(ds.cfmLinks || 0);
    const remote = Number(ds.cfmRemote || 0);
    const banner = card.querySelector(".remote-banner");
    if (!banner) return;
    const blocked = trackers ? `，并移除了 ${trackers} 个追踪像素` : "";
    if (!frame.src.includes("images=1") && remote) {
      banner.hidden = false;
      banner.classList.remove("compact");
      banner.innerHTML = `${icon("shield")}<span>已阻止 ${remote} 张远程图片${blocked}。显示图片时会经隐私代理加载，发件人看不到你的 IP 和设备。</span>
        <button class="link-btn" data-show-img>显示图片</button><button class="link-btn" data-trust>总是显示此发件人的图片</button>`;
      banner.querySelector("[data-show-img]").onclick = () => {
        frame.src = frame.src.replace("images=0", "images=1");
        banner.hidden = true;
        watch();
      };
      banner.querySelector("[data-trust]").onclick = async () => {
        await trustSender(m.from_addr);
        frame.src = frame.src.replace("images=0", "images=1");
        banner.hidden = true;
        watch();
      };
    } else if (trackers || links) {
      const parts = [trackers ? `已拦截 ${trackers} 个追踪像素` : "", links ? `清理了 ${links} 个跟踪链接` : ""].filter(Boolean);
      banner.hidden = false;
      banner.classList.add("compact");
      banner.title = "图片经隐私代理加载，发件人无法得知你何时打开邮件、你的 IP、位置和设备；链接里的跟踪参数已移除";
      banner.innerHTML = `${icon("shieldCheck")}<span>${parts.join(" · ")}</span>`;
    } else banner.hidden = true;
  };
  watch();
}

async function trustSender(addr) {
  try {
    await api("/settings", { method: "PUT", body: { trustSender: addr } });
    store.settings.trustedSenders = [...(store.settings.trustedSenders || []), addr];
    toast(`以后会自动显示 ${addr} 的图片`, { type: "success" });
  } catch (e) {
    toastError(e);
  }
}

async function blockSender(addr) {
  if (!isAdmin()) return threadActionFromReader("spam");
  const ok = await confirmDialog({ title: `屏蔽 ${addr}？`, message: "以后来自这个地址的邮件会直接进入垃圾邮件。可以在「设置 → 防垃圾」中解除。", confirmLabel: "屏蔽" });
  if (!ok) return;
  try {
    await api("/blocklist", { body: { pattern: addr, action: "spam" } });
    await threadAction([store.thread.threadId], "spam", { silent: true });
    toast(`已屏蔽 ${addr}`, { type: "success" });
  } catch (e) {
    toastError(e);
  }
}

async function disableAddress(addr) {
  const ok = await confirmDialog({
    title: `停用 ${addr}？`,
    message: "停用后，发到这个地址的新邮件会被直接拒收（发件方会收到退信）。适合已经泄露、只收到垃圾邮件的地址。可以在「地址管理」中重新启用。",
    confirmLabel: "停用",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/addresses/${encodeURIComponent(addr)}`, { method: "PATCH", body: { blocked: true } });
    toast(`${addr} 已停用`, { type: "success" });
  } catch (e) {
    toastError(e);
  }
}

async function unsubscribe(m) {
  if (!m) return;
  // 退订方式由发件人决定：确认框里写清楚会发生什么（特别是会以你的地址给谁发邮件）
  const u = m.list_unsub || {};
  let to = "";
  try {
    to = u.mailto ? decodeURIComponent(u.mailto.split("?")[0]).trim() : "";
  } catch {}
  const parts = [];
  if (u.oneClick && u.url) parts.push(`将通过发件方提供的一键退订链接，通知 ${esc(m.from_name || m.from_addr)} 不再发送邮件。`);
  if (to) parts.push(`${parts.length ? "如果一键退订失败，" : ""}将以 ${esc(m.mailbox)} 的名义发送一封退订邮件到 ${esc(to)}。`);
  if (!parts.length) parts.push("将打开发件方的退订页面。");
  const ok = await confirmDialog({ title: "退订这个订阅？", message: parts.join("<br>"), confirmLabel: "退订" });
  if (!ok) return;
  try {
    const r = await api(`/messages/${m.id}/unsubscribe`, { body: {} });
    if (r.method === "open") {
      window.open(r.url, "_blank", "noopener,noreferrer");
      toast("已打开退订页面，请在新页面中完成退订");
    } else if (r.method === "mailto") toast(`已发送退订邮件到 ${r.to}`, { type: "success" });
    else toast("已退订", { type: "success" });
  } catch (e) {
    toastError(e);
  }
}

async function aiSummary(el, btn) {
  const box = el.querySelector(".ai-summary");
  box.hidden = false;
  box.innerHTML = `<div class="ai-head">${icon("sparkles")}AI 摘要</div><div class="ai-body muted i18n">${icon("loader", "spin")} 正在总结…</div>`;
  btn.disabled = true;
  try {
    const { summary } = await api("/ai/summarize", { body: { threadId: store.thread.threadId, lang: lang() } });
    box.innerHTML = `<div class="ai-head">${icon("sparkles")}AI 摘要<button class="icon-btn xs" data-close aria-label="关闭窗口">${icon("x")}</button></div><div class="ai-body">${summary ? mdLite(summary) : '<span class="i18n">（没有生成内容）</span>'}</div><div class="ai-foot">由 Workers AI 生成，可能不准确</div>`;
    box.querySelector("[data-close]").onclick = () => (box.hidden = true);
  } catch (e) {
    box.innerHTML = `<div class="ai-head">${icon("sparkles")}AI 摘要</div><div class="ai-body err">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// 翻译成界面语言：译文直接显示在正文的位置（顶部有提示，可以随时切回原文）
async function translate(card, m) {
  const to = lang() === "en" ? "en" : "zh";
  const name = to === "en" ? "英文" : "中文";
  const box = card.querySelector(".msg-ai");
  if (card.classList.contains("collapsed")) expand(card);
  box.hidden = false;
  box.classList.add("tr");
  const show = (translated) => {
    card.classList.toggle("translated", translated);
    box.innerHTML = `<div class="tr-bar">${icon("languages")}<span>${translated ? `已由 AI 翻译成${name}` : "正在显示原文"}</span>
        <button class="link-btn" data-tr-toggle>${translated ? "显示原文" : "显示译文"}</button></div>
      ${translated ? `<div class="text-body tr-text">${m.__translation ? esc(m.__translation) : '<span class="muted i18n">（没有生成内容）</span>'}</div><div class="ai-foot">由 Workers AI 生成，可能不准确</div>` : ""}`;
    box.querySelector("[data-tr-toggle]").onclick = () => show(!translated);
  };
  if (m.__translation !== undefined && m.__translationTo === to) return show(true);
  card.classList.add("translated");
  box.innerHTML = `<div class="tr-bar">${icon("loader", "spin")}<span>正在翻译成${name}…</span></div>`;
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  try {
    const { translation } = await api("/ai/translate", { body: { messageId: m.id, lang: to } });
    m.__translation = translation || "";
    m.__translationTo = to;
    show(true);
  } catch (e) {
    card.classList.remove("translated");
    box.innerHTML = `<div class="tr-bar err">${icon("alert")}<span>${esc(e.message)}</span><button class="link-btn" data-tr-close>关闭</button></div>`;
    box.querySelector("[data-tr-close]").onclick = () => (box.hidden = true);
  }
}

// 极简 Markdown：加粗与列表（AI 输出常用）
function mdLite(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .split(/\n+/)
    .map((l) => (/^\s*([-*•]|\d+[.、])\s+/.test(l) ? `<li>${l.replace(/^\s*([-*•]|\d+[.、])\s+/, "")}</li>` : `<p>${l}</p>`))
    .join("")
    .replace(/(<li>.*?<\/li>)+/g, (x) => `<ul>${x}</ul>`);
}

async function threadActionFromReader(action) {
  const tid = store.thread.threadId;
  if (["star", "unstar"].includes(action)) {
    store.thread.messages.forEach((m, i, arr) => (m.starred = action === "star" ? (i === arr.length - 1 ? 1 : m.starred) : 0));
    patchReader();
  }
  await threadAction([tid], action);
  if (["unread", "spam", "notspam"].includes(action)) navigate(store.route.view, store.route.arg, null);
  else if (["unarchive", "archive"].includes(action) && !["inbox", "archive"].includes(store.route.view)) loadThread(tid);
}

async function messageAction(m, action) {
  if (action === "delete" && !(await confirmDialog({ title: "永久删除这封邮件？", message: "删除后无法恢复。", confirmLabel: "永久删除", danger: true }))) return;
  try {
    await api(`/messages/${m.id}/action`, { body: { action } });
    if (["trash", "delete", "restore"].includes(action)) {
      const rest = store.thread.messages.filter((x) => x.id !== m.id);
      toast(action === "trash" ? "已移到废纸篓" : action === "restore" ? "已恢复" : "已永久删除");
      emit("mail:changed", { keepThread: true });
      if (!rest.length) return navigate(store.route.view, store.route.arg, null);
      store.thread.messages = rest;
      // 只移除这一封的卡片，其他邮件保持原样
      pane()?.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`)?.remove();
      patchReader();
    } else {
      if (action === "star" || action === "unstar") m.starred = action === "star" ? 1 : 0;
      if (action === "read" || action === "unread") m.is_read = action === "read" ? 1 : 0;
      emit("mail:changed", { keepThread: true });
      patchReader();
    }
  } catch (e) {
    toastError(e);
  }
}

// ---------- 图片灯箱 ----------
function lightbox(m, startIndex) {
  const imgs = m.attachments.filter((a) => !a.inline && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(a.mimeType));
  let i = Math.max(0, imgs.findIndex((a) => a.index === startIndex));
  const el = h(`<div class="lightbox" role="dialog" aria-label="图片预览">
    <div class="lb-top"><span class="lb-name"></span><a class="icon-btn" data-dl title="下载" aria-label="下载">${icon("download")}</a><button class="icon-btn" data-close aria-label="关闭窗口">${icon("x")}</button></div>
    <button class="lb-nav prev" aria-label="上一张">${icon("back")}</button>
    <img alt="" />
    <button class="lb-nav next" aria-label="下一张">${icon("chevronRight")}</button>
  </div>`);
  const show = () => {
    const a = imgs[i];
    const url = `/api/messages/${encodeURIComponent(m.id)}/attachments/${a.index}`;
    el.querySelector("img").src = url + "?inline=1";
    el.querySelector(".lb-name").textContent = `${a.filename} · ${fmtSize(a.size)}${imgs.length > 1 ? ` · ${i + 1}/${imgs.length}` : ""}`;
    el.querySelector("[data-dl]").href = url;
    el.querySelectorAll(".lb-nav").forEach((b) => (b.hidden = imgs.length < 2));
  };
  const close = () => {
    el.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") ((i = (i - 1 + imgs.length) % imgs.length), show());
    else if (e.key === "ArrowRight") ((i = (i + 1) % imgs.length), show());
    else return;
    e.stopPropagation();
    e.preventDefault();
  };
  el.querySelector("[data-close]").onclick = close;
  el.querySelector(".prev").onclick = () => ((i = (i - 1 + imgs.length) % imgs.length), show());
  el.querySelector(".next").onclick = () => ((i = (i + 1) % imgs.length), show());
  el.addEventListener("click", (e) => e.target === el && close());
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
  show();
}

// 回复对象：最后一封不是退信通知的邮件（否则会回复给 mailer-daemon）
const replyTarget = (msgs) => [...msgs].reverse().find((m) => !m.is_bounce) ?? msgs[msgs.length - 1];

export function replyToCurrent(mode) {
  const msgs = store.thread?.messages;
  if (msgs?.length) openComposer(replyPrefill(replyTarget(msgs), mode), { mount: replySlot() });
}

export function threadShortcut(action) {
  if (store.thread?.threadId && !store.thread.loading) threadActionFromReader(action);
}

export function readerMenuShortcut(kind) {
  $(kind === "snooze" ? ".reader-pane [data-snooze]" : ".reader-pane [data-labels]")?.click();
}
