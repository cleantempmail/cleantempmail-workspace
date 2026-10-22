// 设置：通用、身份与签名、模板、标签、规则、防垃圾、发件服务、投递与退信、团队成员、数据、快捷键
import { api as rawApi } from "./api.js";
import { createEditor } from "./editor.js";
import { icon } from "./icons.js";
import { createLabel } from "./list.js";
import { disablePush, enablePush, pushSupported } from "./push-client.js";
import { releaseResend } from "./resend.js";
import { addPasskey, passkeySupported } from "./passkey.js";
import { tokenPermsHtml, tokenTemplateUrl } from "./pages.js";
import { t as tr } from "./i18n.js";
import { emit, isAdmin, store } from "./store.js";
import { confirmDialog, modal, toast, toastError } from "./ui.js";
import { esc, fmtRelative, fmtSize, h, prefs } from "./util.js";

// ---------- 数据缓存：先显示缓存，后台刷新（stale-while-revalidate） ----------
const cache = new Map();
let rerender = null;
// 任何修改都清空缓存，避免改完后先闪一下旧数据
const api = (path, opts = {}) => {
  if (opts.body !== undefined || (opts.method && opts.method !== "GET")) cache.clear();
  return rawApi(path, opts);
};
function load(path) {
  const hit = cache.get(path);
  const fresh = rawApi(path).then((data) => {
    const json = JSON.stringify(data);
    const changed = hit && hit.json !== json;
    cache.set(path, { data, json });
    if (path === "/settings") store.settings = data;
    if (changed) rerender?.();
    return data;
  });
  if (hit) {
    fresh.catch(() => {});
    return Promise.resolve(hit.data);
  }
  return fresh;
}
// 进入设置时并行预取所有分页的数据，切换分页时直接用缓存
export function prefetchSettings() {
  const paths = ["/settings", "/identities", "/templates", "/labels"];
  if (isAdmin()) paths.push("/rules", "/blocklist", "/members", "/storage");
  else paths.push("/storage");
  for (const p of paths) if (!cache.has(p)) load(p).catch(() => {});
}

const TABS = [
  ["general", "通用", "settings"],
  ["identities", "身份与签名", "signature"],
  ["templates", "模板", "template"],
  ["labels", "标签", "tag"],
  ["rules", "规则", "workflow", true],
  ["spam", "防垃圾", "shield", true],
  ["sending", "发件服务", "send", true],
  ["delivery", "投递与退信", "activity", true],
  ["members", "团队成员", "users", true],
  ["account", "账户与安全", "key", true],
  ["data", "数据", "database"],
  ["shortcuts", "快捷键", "keyboard"],
];

export async function renderSettingsPage(el, tab) {
  if (store.settings && !cache.has("/settings")) cache.set("/settings", { data: store.settings, json: JSON.stringify(store.settings) });
  prefetchSettings();
  store.settings = await load("/settings");
  const tabs = TABS.filter(([, , , adminOnly]) => !adminOnly || isAdmin());
  if (!tabs.some(([k]) => k === tab)) tab = "general";
  el.innerHTML = `
  <div class="page settings">
    <div class="page-head"><div><h1>设置</h1></div></div>
    <div class="settings-layout">
      <nav class="tabs-v" role="tablist" aria-label="设置分类">${tabs.map(([k, label, ic]) => `<a class="tab-v ${tab === k ? "on" : ""}" href="#/settings/${k}" role="tab" aria-selected="${tab === k}">${icon(ic)}${label}</a>`).join("")}</nav>
      <div class="tab-body"></div>
    </div>
  </div>`;
  const body = el.querySelector(".tab-body");
  const render = { general, identities, templates, labels, rules, spam, sending, delivery, members, account, data, shortcuts }[tab];
  // 没有缓存时先给一个骨架，避免空白
  body.innerHTML = `<section class="set-card"><div class="set-row"><div><i class="sk w40"></i><i class="sk w70"></i></div></div><div class="set-row"><div><i class="sk w70"></i><i class="sk w90"></i></div></div></section>`;
  rerender = () => body.isConnected && render(body).catch(() => {});
  try {
    await render(body);
  } catch (e) {
    body.innerHTML = `<div class="notice err">${icon("alert")}<span>${esc(e.message)}</span></div>`;
  }
}

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}" role="radiogroup">${options.map(([v, label, ic]) => `<button class="${String(v) === String(value) ? "on" : ""}" data-v="${v}" role="radio" aria-checked="${String(v) === String(value)}">${ic ? icon(ic) : ""}${label}</button>`).join("")}</div>`;
}
function bindSeg(body, handlers) {
  body.querySelectorAll("[data-seg]").forEach((g) =>
    g.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      g.querySelectorAll("button").forEach((x) => (x.classList.toggle("on", x === b), x.setAttribute("aria-checked", String(x === b))));
      await handlers[g.dataset.seg]?.(b.dataset.v);
      toast("已保存", { type: "success", duration: 1200 });
    }),
  );
}
const switchHtml = (attr, on) => `<label class="switch"><input type="checkbox" ${attr} ${on ? "checked" : ""} /><span></span></label>`;

// ---------- 通用 ----------
async function general(body) {
  const s = store.settings;
  const admin = isAdmin();
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>语言 / Language</b><span>界面语言（不影响邮件内容）</span></div>
        ${seg("lang", [["auto", "自动"], ["zh", "中文"], ["en", "English"]], prefs.get("lang", "auto"))}</div>
      <div class="set-row"><div><b>外观</b><span>跟随系统时会随 macOS / Windows 的深色模式自动切换</span></div>
        ${seg("theme", [["auto", "跟随系统", "monitor"], ["light", "浅色", "sun"], ["dark", "深色", "moon"]], prefs.get("theme", "auto"))}</div>
      <div class="set-row"><div><b>列表密度</b><span>紧凑模式下一屏能看到更多邮件</span></div>
        ${seg("density", [["comfortable", "舒适"], ["compact", "紧凑"]], prefs.get("density", "comfortable"))}</div>
      <div class="set-row"><div><b>阅读窗格</b><span>关闭后点开邮件会占满整个区域（列表宽度可以拖动分隔线调整）</span></div>
        ${seg("pane", [["right", "右侧", "columns"], ["off", "关闭", "layers"]], prefs.get("readingPane", "right"))}</div>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>撤销发送</b><span>点击发送后等待几秒再真正发出，期间可以撤销</span></div>
        ${seg("undo", [["0", "关闭"], ["5", "5 秒"], ["10", "10 秒"], ["20", "20 秒"]], prefs.get("undoSeconds", 5))}</div>
      <div class="set-row"><div><b>回复方式</b><span>「弹出窗口」在右下角打开写信窗口；「在会话中」会在邮件下方直接展开写信框，可随时弹出为独立窗口</span></div>
        ${seg("replyMode", [["window", "弹出窗口"], ["inline", "在会话中"]], prefs.get("replyMode", "window"))}</div>
      <div class="set-row"><div><b>回复和转发的引用语言</b><span>引用原文时插入的「…写道：」和转发信息用哪种语言。「跟随原邮件」会根据原邮件的文字自动选择：回复英文邮件用英文，回复中文邮件用中文</span></div>
        ${seg("quoteLang", [["auto", "跟随原邮件"], ["zh", "中文"], ["en", "English"]], prefs.get("quoteLang", "auto"))}</div>
      <div class="set-row"><div><b>新邮件推送通知</b><span>${pushSupported() ? "即使关闭了页面，收到新邮件也会弹出系统通知（每台设备单独开启）" : "这个浏览器不支持推送通知"}</span></div>
        ${switchHtml(`data-notify ${pushSupported() ? "" : "disabled"}`, prefs.get("notify", false))}</div>
      <div class="set-row"><div><b>键盘快捷键</b><span>j/k 切换、e 归档、r 回复等，按 ? 查看全部</span></div>
        ${switchHtml("data-shortcuts", prefs.get("shortcuts", true))}</div>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>远程图片</b><span>防追踪始终开启：图片经本服务的隐私代理加载，发件人看不到你的 IP、位置和设备；追踪像素和链接里的跟踪参数会被自动移除${admin ? "" : "（由管理员设置）"}</span></div>
        ${admin ? seg("images", [["always", "自动显示"], ["ask", "先询问"]], s.remoteImages) : `<span class="status off">${s.remoteImages === "always" ? "自动显示" : "先询问"}</span>`}</div>
      ${
        s.trustedSenders?.length
          ? `<div class="set-sub"><b>总是显示图片的发件人</b><div class="pill-list">${s.trustedSenders.map((a) => `<span class="pill">${esc(a)}<button data-untrust="${esc(a)}" aria-label="移除">${icon("x")}</button></span>`).join("")}</div></div>`
          : ""
      }
    </section>`;
  bindSeg(body, {
    lang: (v) => {
      prefs.set("lang", v);
      setTimeout(() => location.reload(), 300);
    },
    theme: (v) => (prefs.set("theme", v), emit("prefs:changed")),
    density: (v) => (prefs.set("density", v), emit("prefs:changed")),
    pane: (v) => (prefs.set("readingPane", v), emit("prefs:changed")),
    undo: (v) => prefs.set("undoSeconds", Number(v)),
    quoteLang: (v) => prefs.set("quoteLang", v),
    replyMode: (v) => prefs.set("replyMode", v),
    images: async (v) => {
      await api("/settings", { method: "PUT", body: { remoteImages: v } }).catch(toastError);
      store.settings.remoteImages = v;
    },
  });
  body.querySelector("[data-notify]").onchange = async (e) => {
    try {
      if (e.target.checked) {
        await enablePush();
        toast("已开启推送通知", { type: "success" });
      } else {
        await disablePush();
        toast("已关闭推送通知");
      }
    } catch (err) {
      e.target.checked = false;
      toastError(err);
    }
  };
  body.querySelector("[data-shortcuts]").onchange = (e) => prefs.set("shortcuts", e.target.checked);
  body.querySelectorAll("[data-untrust]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api("/settings", { method: "PUT", body: { untrustSender: b.dataset.untrust } }).catch(toastError);
        store.settings.trustedSenders = store.settings.trustedSenders.filter((x) => x !== b.dataset.untrust);
        general(body);
      }),
  );
}

// ---------- 身份与签名 ----------
async function identities(body) {
  store.identities = await load("/identities");
  const ids = store.identities;
  const label = (a) => (a === "*" ? "全局默认" : a.startsWith("@") ? `${a} 下的所有地址` : a);
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>发件身份</b><span>为某个地址、整个域名或全部地址设置显示名和签名。匹配顺序：完整地址 → @域名 → 全局默认。</span></div>
        <button class="btn primary sm" data-new>${icon("plus")}新建</button></div>
      ${
        ids.length
          ? `<div class="id-list">${ids
              .map(
                (i) => `<div class="id-row"><span class="id-ic">${icon(i.address === "*" ? "globe" : i.address.startsWith("@") ? "hash" : "at")}</span>
              <div class="id-main"><b>${esc(label(i.address))}</b><span class="muted small">${esc(i.name || "（未设置显示名）")}${i.signature ? " · 有签名" : ""}</span></div>
              <button class="btn sm ghost" data-edit="${esc(i.address)}">编辑</button>
              <button class="icon-btn sm" data-del="${esc(i.address)}" aria-label="删除">${icon("trash")}</button></div>`,
              )
              .join("")}</div>`
          : `<div class="set-empty muted">还没有设置。建议先建一个「全局默认」，填上你的名字和签名。</div>`
      }
    </section>`;
  body.querySelector("[data-new]").onclick = () => identityModal(null, () => identities(body));
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => identityModal(ids.find((i) => i.address === b.dataset.edit), () => identities(body))));
  body.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog({ title: "删除这个身份？", message: `「${esc(label(b.dataset.del))}」的显示名和签名将被删除。`, confirmLabel: "删除", danger: true }))) return;
        await api(`/identities/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" }).catch(toastError);
        identities(body);
      }),
  );
}

function identityModal(existing, done) {
  const addrs = [...new Set(store.stats.mailboxes.map((m) => m.mailbox))];
  const opts = isAdmin() ? ["*", ...store.domains.map((d) => "@" + d.name), ...addrs] : addrs;
  const body = h(`<div class="form">
    <label class="field-label">适用于</label>
    <input class="input" list="id-addrs" value="${esc(existing?.address ?? (isAdmin() ? "*" : addrs[0] ?? ""))}" ${existing ? "disabled" : ""} placeholder="* / @域名 / 完整地址" />
    <datalist id="id-addrs">${opts.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
    <p class="hint">${isAdmin() ? "* 表示全局默认；@example.com 表示该域名下的所有地址；也可以填写某个具体地址。" : "填写你有权限使用的完整地址。"}</p>
    <label class="field-label">显示名</label>
    <input class="input" data-name value="${esc(existing?.name ?? "")}" placeholder="例如：张三 / 销售部" />
    <label class="field-label">签名</label>
    <div class="sig-slot"></div>
  </div>`);
  const editor = createEditor({ html: existing?.signature ?? "", placeholder: "例如：张三 | 销售经理 | 138-0000-0000" });
  body.querySelector(".sig-slot").appendChild(editor.el);
  modal({
    title: existing ? "编辑身份" : "新建身份",
    body,
    wide: true,
    actions: [
      { label: "取消" },
      {
        label: "保存",
        kind: "primary",
        onClick: async () => {
          await api("/identities", {
            method: "PUT",
            body: { address: body.querySelector("input").value, name: body.querySelector("[data-name]").value, signature: editor.isEmpty() ? "" : editor.getHtml() },
          });
          store.identities = await api("/identities");
          toast("已保存", { type: "success" });
          done();
        },
      },
    ],
  });
}

// ---------- 模板 ----------
async function templates(body) {
  const list = await load("/templates");
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>邮件模板</b><span>常用的回复内容。写信时点工具栏的 ${icon("template")} 插入，团队成员共享。</span></div>
        <button class="btn primary sm" data-new>${icon("plus")}新建</button></div>
      ${
        list.length
          ? `<div class="id-list">${list
              .map(
                (t) => `<div class="id-row"><span class="id-ic">${icon("template")}</span>
              <div class="id-main"><b>${esc(t.name)}</b><span class="muted small">${esc(t.subject || "（不设置主题）")} · 更新于 ${fmtRelative(t.updated_at)}</span></div>
              <button class="btn sm ghost" data-edit="${esc(t.id)}">编辑</button>
              <button class="icon-btn sm" data-del="${esc(t.id)}" aria-label="删除">${icon("trash")}</button></div>`,
              )
              .join("")}</div>`
          : `<div class="set-empty muted">还没有模板。也可以在写信时把当前内容「存为模板」。</div>`
      }
    </section>`;
  const edit = (t) => {
    const form = h(`<div class="form">
      <label class="field-label">名称</label><input class="input" data-name value="${esc(t?.name ?? "")}" placeholder="例如：报价回复" />
      <label class="field-label">主题（可选，插入时如果主题为空会自动填上）</label><input class="input" data-subject value="${esc(t?.subject ?? "")}" />
      <label class="field-label">内容</label><div class="sig-slot"></div></div>`);
    const editor = createEditor({ html: t?.html ?? "", placeholder: "模板正文" });
    form.querySelector(".sig-slot").appendChild(editor.el);
    modal({
      title: t ? "编辑模板" : "新建模板",
      body: form,
      wide: true,
      actions: [
        { label: "取消" },
        {
          label: "保存",
          kind: "primary",
          onClick: async () => {
            await api(`/templates/${t?.id ?? crypto.randomUUID()}`, { method: "PUT", body: { name: form.querySelector("[data-name]").value, subject: form.querySelector("[data-subject]").value, html: editor.getHtml() } });
            toast("已保存", { type: "success" });
            templates(body);
          },
        },
      ],
    });
  };
  body.querySelector("[data-new]").onclick = () => edit(null);
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => edit(list.find((t) => t.id === b.dataset.edit))));
  body.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog({ title: "删除这个模板？", message: "删除后无法恢复。", confirmLabel: "删除", danger: true }))) return;
        await api(`/templates/${b.dataset.del}`, { method: "DELETE" }).catch(toastError);
        templates(body);
      }),
  );
}

// ---------- 标签 ----------
async function labels(body) {
  store.labels = await load("/labels");
  const counts = new Map((store.stats.labels || []).map((l) => [l.label_id, l.n]));
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>标签</b><span>一个会话可以有多个标签。可以手动添加，也可以用「规则」自动添加。</span></div>
        <button class="btn primary sm" data-new>${icon("plus")}新建</button></div>
      ${
        store.labels.length
          ? `<div class="id-list">${store.labels
              .map(
                (l) => `<div class="id-row"><span class="label-dot lg" style="--lc:${esc(l.color)}"></span>
              <div class="id-main"><b>${esc(l.name)}</b><span class="muted small">${counts.get(l.id) ?? 0} 个会话</span></div>
              <a class="btn sm ghost" href="#/label/${encodeURIComponent(l.id)}">查看</a>
              <button class="btn sm ghost" data-rename="${esc(l.id)}">重命名</button>
              ${isAdmin() ? `<button class="icon-btn sm" data-del="${esc(l.id)}" aria-label="删除">${icon("trash")}</button>` : ""}</div>`,
              )
              .join("")}</div>`
          : `<div class="set-empty muted">还没有标签。</div>`
      }
    </section>`;
  body.querySelector("[data-new]").onclick = async () => (await createLabel()) && labels(body);
  body.querySelectorAll("[data-rename]").forEach(
    (b) =>
      (b.onclick = async () => {
        const l = store.labels.find((x) => x.id === b.dataset.rename);
        const { promptDialog } = await import("./ui.js");
        const name = await promptDialog({ title: "重命名标签", label: "名称", value: l.name });
        if (!name?.trim()) return;
        await api(`/labels/${l.id}`, { method: "PUT", body: { name: name.trim(), color: l.color } }).catch(toastError);
        emit("labels:changed");
        labels(body);
      }),
  );
  body.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog({ title: "删除这个标签？", message: "邮件不会被删除，只是去掉这个标签。", confirmLabel: "删除", danger: true }))) return;
        await api(`/labels/${b.dataset.del}`, { method: "DELETE" }).catch(toastError);
        emit("labels:changed");
        labels(body);
      }),
  );
}

// ---------- 规则 ----------
const FIELDS = [
  ["to", "收件地址"],
  ["from", "发件人"],
  ["subject", "主题"],
  ["body", "正文"],
  ["has_attachment", "有附件"],
];
const OPS = [
  ["contains", "包含"],
  ["not_contains", "不包含"],
  ["equals", "等于"],
  ["starts", "开头是"],
  ["ends", "结尾是"],
];

async function rules(body) {
  const [list] = await Promise.all([load("/rules"), load("/labels").then((l) => (store.labels = l))]);
  const desc = (r) => {
    // 逐词翻译后再拼句子（整句无法用词典匹配）
    const en = document.documentElement.lang === "en";
    const c = r.conditions.map((x) => (x.field === "has_attachment" ? tr("有附件") : `${tr(FIELDS.find((f) => f[0] === x.field)?.[1] ?? "")} ${tr(OPS.find((o) => o[0] === x.op)?.[1] ?? "")} “${x.value}”`)).join(en ? (r.match_all ? " and " : " or ") : r.match_all ? " 且 " : " 或 ");
    const a = [
      ...(r.actions.labels ?? []).map((id) => `${en ? "label" : "标签"} “${store.labels.find((l) => l.id === id)?.name ?? "?"}”`),
      r.actions.archive && tr("归档"),
      r.actions.star && tr("加星标"),
      r.actions.read && tr("标为已读"),
      r.actions.spam && tr("移到垃圾邮件"),
      r.actions.mute && tr("不推送通知"),
      r.actions.forward && `${en ? "forward to" : "转发到"} ${r.actions.forward}`,
    ].filter(Boolean);
    return en ? `If ${c}, then ${a.join(", ").toLowerCase() || "(no action)"}` : `如果 ${c}，则 ${a.join("、") || "（无动作）"}`;
  };
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>收信规则</b><span>新邮件到达时按顺序检查，符合条件就自动打标签、归档、加星标、转发等。</span></div>
        <button class="btn primary sm" data-new>${icon("plus")}新建规则</button></div>
      ${
        list.length
          ? `<div class="id-list">${list
              .map(
                (r) => `<div class="id-row ${r.enabled ? "" : "disabled"}"><span class="id-ic">${icon("workflow")}</span>
              <div class="id-main"><b>${esc(r.name)}</b><span class="muted small">${esc(desc(r))}</span><span class="muted small i18n">已触发 ${r.hits} 次</span></div>
              ${switchHtml(`data-toggle="${esc(r.id)}"`, r.enabled)}
              <button class="btn sm ghost" data-edit="${esc(r.id)}">编辑</button>
              <button class="icon-btn sm" data-del="${esc(r.id)}" aria-label="删除">${icon("trash")}</button></div>`,
              )
              .join("")}</div>`
          : `<div class="set-empty muted">还没有规则。例如：「收件地址 包含 newsletter@ → 标签『订阅』+ 归档」。</div>`
      }
    </section>`;
  body.querySelector("[data-new]").onclick = () => ruleModal(null, () => rules(body));
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => ruleModal(list.find((r) => r.id === b.dataset.edit), () => rules(body))));
  body.querySelectorAll("[data-toggle]").forEach(
    (i) =>
      (i.onchange = async () => {
        const r = list.find((x) => x.id === i.dataset.toggle);
        await api(`/rules/${r.id}`, { method: "PUT", body: { ...r, enabled: i.checked, match_all: Boolean(r.match_all) } }).catch(toastError);
        rules(body);
      }),
  );
  body.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog({ title: "删除这条规则？", message: "已经处理过的邮件不受影响。", confirmLabel: "删除", danger: true }))) return;
        await api(`/rules/${b.dataset.del}`, { method: "DELETE" }).catch(toastError);
        rules(body);
      }),
  );
}

function ruleModal(r, done) {
  const conds = r?.conditions?.length ? structuredClone(r.conditions) : [{ field: "to", op: "contains", value: "" }];
  const a = r?.actions ?? {};
  const form = h(`<div class="form rule-form">
    <label class="field-label">规则名称</label><input class="input" data-name value="${esc(r?.name ?? "")}" placeholder="例如：订阅邮件自动归档" />
    <label class="field-label">条件 <select class="mini-select" data-match><option value="1" ${r?.match_all !== 0 ? "selected" : ""}>满足全部</option><option value="0" ${r?.match_all === 0 ? "selected" : ""}>满足任意一个</option></select></label>
    <div class="cond-list"></div>
    <button type="button" class="link-btn" data-add-cond>${icon("plus")}添加条件</button>
    <label class="field-label">动作</label>
    <div class="action-grid">
      <label class="chk"><input type="checkbox" data-a="archive" ${a.archive ? "checked" : ""}/>归档（不进收件箱）</label>
      <label class="chk"><input type="checkbox" data-a="star" ${a.star ? "checked" : ""}/>加星标</label>
      <label class="chk"><input type="checkbox" data-a="read" ${a.read ? "checked" : ""}/>标为已读</label>
      <label class="chk"><input type="checkbox" data-a="mute" ${a.mute ? "checked" : ""}/>不推送通知</label>
      <label class="chk"><input type="checkbox" data-a="spam" ${a.spam ? "checked" : ""}/>移到垃圾邮件</label>
    </div>
    <label class="field-label">添加标签</label>
    <div class="pill-list">${store.labels.map((l) => `<label class="pill pick"><input type="checkbox" data-label="${esc(l.id)}" ${(a.labels ?? []).includes(l.id) ? "checked" : ""}/><span class="label-dot" style="--lc:${esc(l.color)}"></span>${esc(l.name)}</label>`).join("") || `<span class="muted small">还没有标签，可以先在「标签」中创建</span>`}</div>
    <label class="field-label">转发到（可选）</label>
    <input class="input" data-forward value="${esc(a.forward ?? "")}" placeholder="必须是 Cloudflare Email Routing 中已验证的目标地址" />
  </div>`);
  const drawConds = () => {
    const box = form.querySelector(".cond-list");
    box.innerHTML = conds
      .map(
        (c, i) => `<div class="cond-row" data-i="${i}">
        <select class="mini-select" data-f>${FIELDS.map(([v, l]) => `<option value="${v}" ${c.field === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${c.field === "has_attachment" ? `<span class="muted small cond-fill">（有附件的邮件）</span>` : `<select class="mini-select" data-o>${OPS.map(([v, l]) => `<option value="${v}" ${c.op === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <input class="input sm" data-v value="${esc(c.value ?? "")}" placeholder="${c.field === "to" ? "例如 newsletter@" : c.field === "from" ? "例如 @github.com" : "关键词"}" />`}
        <button type="button" class="icon-btn sm" data-rm aria-label="删除条件" ${conds.length < 2 ? "disabled" : ""}>${icon("x")}</button></div>`,
      )
      .join("");
    box.querySelectorAll(".cond-row").forEach((row) => {
      const c = conds[Number(row.dataset.i)];
      row.querySelector("[data-f]").onchange = (e) => {
        c.field = e.target.value;
        if (c.field === "has_attachment") c.value = "true";
        drawConds();
      };
      row.querySelector("[data-o]")?.addEventListener("change", (e) => (c.op = e.target.value));
      row.querySelector("[data-v]")?.addEventListener("input", (e) => (c.value = e.target.value));
      row.querySelector("[data-rm]").onclick = () => {
        conds.splice(Number(row.dataset.i), 1);
        drawConds();
      };
    });
  };
  drawConds();
  form.querySelector("[data-add-cond]").onclick = () => {
    conds.push({ field: "from", op: "contains", value: "" });
    drawConds();
  };
  modal({
    title: r ? "编辑规则" : "新建规则",
    body: form,
    wide: true,
    actions: [
      { label: "取消" },
      {
        label: "保存",
        kind: "primary",
        onClick: async () => {
          const actions = { labels: [...form.querySelectorAll("[data-label]:checked")].map((i) => i.dataset.label) };
          form.querySelectorAll("[data-a]").forEach((i) => i.checked && (actions[i.dataset.a] = true));
          const fwd = form.querySelector("[data-forward]").value.trim();
          if (fwd) actions.forward = fwd;
          const clean = conds.filter((c) => c.field === "has_attachment" || c.value?.trim());
          if (!clean.length) throw new Error("请至少填写一个条件");
          await api(`/rules/${r?.id ?? crypto.randomUUID()}`, {
            method: "PUT",
            body: { name: form.querySelector("[data-name]").value, enabled: r ? Boolean(r.enabled) : true, match_all: form.querySelector("[data-match]").value === "1", conditions: clean, actions },
          });
          toast("规则已保存，之后收到的邮件会按它处理", { type: "success" });
          done();
        },
      },
    ],
  });
}

// ---------- 防垃圾 ----------
async function spam(body) {
  const s = store.settings;
  const list = await load("/blocklist");
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>自动判定</b><span>以下情况的邮件会直接放进「垃圾邮件」：发件人身份验证（DMARC）失败、发件人在屏蔽名单中、规则指定。</span></div></div>
      <div class="set-row"><div><b>Cloudflare 垃圾评分阈值</b><span>Cloudflare 收信时会给每封邮件打分（X-CF-SpamH-Score）。设置一个数值后，评分大于等于它的邮件会进入垃圾邮件；留空表示不按评分判定。可以先在邮件「详情」中观察实际评分再决定。</span></div>
        <div class="form-inline tight"><input class="input sm num" data-score type="number" step="1" min="0" value="${esc(s.spamScore ?? "")}" placeholder="不启用" /><button class="btn sm" data-save-score>保存</button></div></div>
      <div class="set-row"><div><b>AI 判定陌生发件人</b><span>${store.me.ai ? "联系人列表以外的发件人来信时，用 Workers AI 判断是否为垃圾或钓鱼邮件。会消耗少量 Workers AI 额度。" : "需要配置 Workers AI 绑定"}</span></div>
        ${switchHtml(`data-ai ${store.me.ai ? "" : "disabled"}`, s.aiSpam)}</div>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>屏蔽名单</b><span>可以屏蔽某个地址或整个域名（@example.com）。「进入垃圾邮件」会静默收下；「直接拒收」会让对方收到退信。</span></div></div>
      <div class="form-inline"><input class="input" data-pattern placeholder="spammer@example.com 或 @example.com" />
        <select class="mini-select" data-action><option value="spam">进入垃圾邮件</option><option value="reject">直接拒收</option></select>
        <button class="btn primary" data-add>添加</button></div>
      ${
        list.length
          ? `<div class="id-list">${list
              .map(
                (b) => `<div class="id-row"><span class="id-ic">${icon(b.action === "reject" ? "ban" : "shieldAlert")}</span>
              <div class="id-main"><b>${esc(b.pattern)}</b><span class="muted small">${b.action === "reject" ? "直接拒收" : "进入垃圾邮件"} · ${fmtRelative(b.created_at)}</span></div>
              <button class="icon-btn sm" data-del="${esc(b.pattern)}" aria-label="移除">${icon("trash")}</button></div>`,
              )
              .join("")}</div>`
          : `<div class="set-empty muted">屏蔽名单为空。在邮件上选择「屏蔽发件人」也会加到这里。</div>`
      }
    </section>`;
  body.querySelector("[data-save-score]").onclick = async () => {
    await api("/settings", { method: "PUT", body: { spamScore: body.querySelector("[data-score]").value } }).catch(toastError);
    toast("已保存", { type: "success" });
  };
  body.querySelector("[data-ai]").onchange = async (e) => {
    await api("/settings", { method: "PUT", body: { aiSpam: e.target.checked } }).catch(toastError);
    toast(e.target.checked ? "已开启 AI 判定" : "已关闭 AI 判定", { type: "success" });
  };
  body.querySelector("[data-add]").onclick = async () => {
    try {
      await api("/blocklist", { body: { pattern: body.querySelector("[data-pattern]").value, action: body.querySelector("[data-action]").value } });
      spam(body);
    } catch (e) {
      toastError(e);
    }
  };
  body.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api(`/blocklist/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" }).catch(toastError);
        spam(body);
      }),
  );
}

// ---------- 发件服务 ----------
function sending(body) {
  const s = store.settings;
  const byProvider = (p) => store.domains.filter((d) => d.send_provider === p).map((d) => d.name);
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>${icon("cloud")} Cloudflare Email Sending</b><span>使用本 Worker 的发件绑定，无需额外配置。需要账户开通 Workers Paid（$5/月），目前为 Beta；新账户每日额度较低，会随信誉逐步提高。单封邮件上限 5 MB。</span></div></div>
      <div class="set-sub muted small">使用中：${byProvider("cloudflare").map(esc).join("、") || "无"}</div>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>${icon("send")} Resend ${s.resendConfigured ? `<span class="status ok">已配置</span>` : `<span class="status off">未配置</span>`}</b>
        <span>适合没有 Workers Paid 的账户（免费版每月 3000 封）。API Key 需要 Full access 权限，用于自动添加域名并写入 DNS。单封邮件上限 20 MB。</span></div></div>
      <div class="form-inline">
        <input type="password" class="input" data-key placeholder="${s.resendConfigured ? "已保存（输入新值可替换）" : "re_..."}" autocomplete="off" />
        <button class="btn primary" data-save>保存</button>
        ${s.resendConfigured ? `<button class="btn danger" data-clear>删除</button>` : ""}
      </div>
      <div class="set-sub muted small">Key 加密后保存在你自己账户的 D1 中${s.appSecret ? "（密钥与数据分开存放）" : ""} · <a href="https://resend.com/api-keys" target="_blank" rel="noopener">获取 API Key</a> · 使用中：${byProvider("resend").map(esc).join("、") || "无"}</div>
      ${s.resendConfigured ? `<div class="resend-usage" data-usage><div class="set-sub muted small">${icon("loader", "spin")} 正在读取 Resend 里的域名…</div></div>` : ""}
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>系统发件地址</b><span>团队成员的登录链接、邀请邮件从这个地址发出。留空时自动使用第一个已开通发件的域名的 noreply@。</span></div></div>
      <div class="form-inline"><input class="input" data-sys value="${esc(s.systemFrom ?? "")}" placeholder="noreply@你的域名" /><button class="btn primary" data-save-sys>保存</button></div>
    </section>`;
  const usage = body.querySelector("[data-usage]");
  if (usage) resendUsage(usage, () => sending(body));
  body.querySelector("[data-save]").onclick = async () => {
    const v = body.querySelector("[data-key]").value.trim();
    if (!v) return toast("请输入 API Key", { type: "error" });
    try {
      await api("/settings", { method: "PUT", body: { resendApiKey: v } });
      store.settings = await load("/settings");
      toast("已保存", { type: "success" });
      sending(body);
    } catch (e) {
      toastError(e);
    }
  };
  body.querySelector("[data-clear]")?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "删除 Resend API Key？", message: "使用 Resend 的域名将无法发件。", confirmLabel: "删除", danger: true }))) return;
    await api("/settings", { method: "PUT", body: { resendApiKey: null } });
    store.settings = await load("/settings");
    sending(body);
  });
  body.querySelector("[data-save-sys]").onclick = async () => {
    try {
      await api("/settings", { method: "PUT", body: { systemFrom: body.querySelector("[data-sys]").value } });
      toast("已保存", { type: "success" });
    } catch (e) {
      toastError(e);
    }
  };
}

// Resend 名额用量：Resend 按账户里的域名数计算，不论是否验证通过、本应用是否还在用
const RESEND_STATUS = { verified: ["ok", "已验证"], pending: ["warn", "验证中"], not_started: ["off", "未验证"], failed: ["err", "验证失败"], temporary_failure: ["warn", "暂时失败"] };
async function resendUsage(box, refresh) {
  try {
    const r = await load("/resend/domains");
    if (!r.configured) return void (box.hidden = true);
    const n = r.domains.length;
    const use = { primary: "本应用 · 主发件", backup: "本应用 · 备用发件" };
    box.innerHTML = `<div class="set-sub usage-head"><b>Resend 域名名额</b><span class="muted small">已用 ${n} 个，免费版上限 ${r.freeLimit} 个${n >= r.freeLimit ? "，已满" : ""}</span></div>
      ${
        n
          ? `<div class="id-list">${r.domains
              .map((d) => {
                const [cls, label] = RESEND_STATUS[d.status] ?? ["off", d.status];
                return `<div class="id-row"><span class="id-ic">${icon("globe")}</span>
                  <div class="id-main"><b>${esc(d.name)}</b><span class="muted small">${d.inApp ? (use[d.usage] ?? "本应用没有用它发件，但仍占用名额") : "不在本应用中（可能被其他项目使用，请在 Resend 后台管理）"}</span></div>
                  <span class="status ${cls}">${esc(label)}</span>
                  ${d.inApp ? `<button class="btn sm ghost" data-release="${esc(d.name)}">释放</button>` : ""}</div>`;
              })
              .join("")}</div>`
          : ""
      }`;
    box.querySelectorAll("[data-release]").forEach(
      (b) =>
        (b.onclick = () =>
          releaseResend(b.dataset.release, () => {
            cache.delete("/resend/domains");
            refresh();
          })),
    );
  } catch (e) {
    box.innerHTML = `<div class="set-sub muted small">读取 Resend 域名失败：${esc(e.message)}</div>`;
  }
}

// ---------- 投递与退信 ----------
async function delivery(body) {
  const s = store.settings;
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>投递状态</b><span>通过 Cloudflare 的分析接口查询每封外发邮件是否送达（仅 Cloudflare Email Sending）。每 15 分钟自动更新一次，已发送邮件上会显示「已送达 / 退信」。</span></div>
        ${s.analyticsScope === true ? `<span class="status ok">已启用</span>` : s.analyticsScope === false ? `<span class="status warn">缺少权限</span>` : `<span class="status off">需要重新登录</span>`}</div>
      ${
        s.analyticsScope === false
          ? `<div class="set-sub"><div class="notice warn sm">${icon("alert")}<span>需要在 Cloudflare 的 OAuth 客户端中勾选 <code>analytics.read</code>（Analytics Read），然后<a href="/auth/login">重新登录</a>。退信通知不受影响，仍会自动识别。</span></div></div>`
          : `<div class="set-sub"><button class="btn sm" data-refresh>${icon("refresh")}立即更新</button></div>`
      }
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>抑制列表</b><span>硬退信或被投诉的收件人会被 Cloudflare 自动屏蔽，之后发给他们的邮件会被拒绝。确认地址恢复正常后可以在这里解除。</span></div>
        <button class="btn sm" data-load>${icon("refresh")}读取</button></div>
      <div class="supp-list"></div>
    </section>`;
  body.querySelector("[data-refresh]")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api("/delivery/refresh", { body: {} });
      if (r.needsScope) toast("缺少 analytics.read 权限", { type: "error" });
      else toast(`已更新 ${r.updated} 封邮件的投递状态`, { type: "success" });
    } catch (err) {
      toastError(err);
    }
    e.currentTarget.disabled = false;
  });
  const load = async () => {
    const box = body.querySelector(".supp-list");
    box.innerHTML = `<div class="set-empty muted">${icon("loader", "spin")} 读取中…</div>`;
    try {
      const list = await api("/suppressions");
      box.innerHTML = list.length
        ? `<div class="id-list">${list
            .map(
              (x) => `<div class="id-row"><span class="id-ic">${icon("ban")}</span><div class="id-main"><b>${esc(x.email ?? x.address ?? x.recipient ?? "")}</b>
            <span class="muted small">${esc(x.reason ?? x.type ?? "")}${x.created ? " · " + esc(new Date(x.created).toLocaleString("zh-CN")) : ""}</span></div>
            <button class="btn sm ghost" data-unsupp="${esc(x.id)}">解除</button></div>`,
            )
            .join("")}</div>`
        : `<div class="set-empty muted">抑制列表为空。</div>`;
      box.querySelectorAll("[data-unsupp]").forEach(
        (b) =>
          (b.onclick = async () => {
            await api(`/suppressions/${encodeURIComponent(b.dataset.unsupp)}`, { method: "DELETE" }).catch(toastError);
            load();
          }),
      );
    } catch (e) {
      box.innerHTML = `<div class="set-empty"><div class="notice warn sm">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    }
  };
  body.querySelector("[data-load]").onclick = load;
}

// ---------- 团队成员 ----------
async function members(body) {
  const list = await load("/members");
  const scopeText = (s) => (s.all ? "全部域名" : [...s.domains.map((d) => "@" + d), ...s.addresses].join("、") || "（无）");
  const memberLogin = store.settings?.memberLogin !== false;
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>成员邮箱登录</b><span>开启后，登录页会显示「团队成员」邮箱登录入口（没有可用成员时自动隐藏）。关闭后入口隐藏，成员也无法再获取新的登录链接；已登录的成员不受影响。</span></div>
        ${switchHtml("data-member-login", memberLogin)}</div>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>团队成员</b><span>成员用邮箱登录（无需 Cloudflare 账户），只能看到和使用你授权的域名或地址，不能管理域名和系统设置。</span></div>
        <button class="btn primary sm" data-new>${icon("plus")}添加成员</button></div>
      ${
        list.length
          ? `<div class="id-list">${list
              .map(
                (m) => `<div class="id-row ${m.disabled ? "disabled" : ""}"><span class="id-ic">${icon("user")}</span>
              <div class="id-main"><b>${esc(m.name ? `${m.name} · ${m.email}` : m.email)}</b><span class="muted small">可访问：${esc(scopeText(m.scope))} · ${m.last_login_at ? "最近登录 " + fmtRelative(m.last_login_at) : "尚未登录"}${m.disabled ? " · 已停用" : ""}</span></div>
              ${m.disabled ? "" : `<button class="btn sm ghost" data-invite="${esc(m.id)}">${icon("mail")}发送登录链接</button>`}
              <button class="btn sm ghost" data-edit="${esc(m.id)}">编辑</button>
              <button class="icon-btn sm" data-del="${esc(m.id)}" aria-label="删除">${icon("trash")}</button></div>`,
              )
              .join("")}</div>`
          : `<div class="set-empty muted">还没有成员。添加后可以给他发送登录链接。</div>`
      }
    </section>`;
  body.querySelector("[data-member-login]").onchange = async (e) => {
    try {
      await api("/settings", { method: "PUT", body: { memberLogin: e.target.checked } });
      store.settings.memberLogin = e.target.checked;
      toast(e.target.checked ? "已开启成员邮箱登录" : "已关闭成员邮箱登录", { type: "success" });
    } catch (err) {
      e.target.checked = !e.target.checked;
      toastError(err);
    }
  };
  body.querySelector("[data-new]").onclick = () => memberModal(null, () => members(body));
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => memberModal(list.find((m) => m.id === b.dataset.edit), () => members(body))));
  body.querySelectorAll("[data-invite]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api(`/members/${b.dataset.invite}/invite`, { body: {} });
          toast("登录链接已发送（7 天内有效）", { type: "success" });
        } catch (e) {
          toastError(e);
        }
        b.disabled = false;
      }),
  );
  body.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog({ title: "删除这个成员？", message: "他会立即退出登录，无法再访问。", confirmLabel: "删除", danger: true }))) return;
        await api(`/members/${b.dataset.del}`, { method: "DELETE" }).catch(toastError);
        members(body);
      }),
  );
}

function memberModal(m, done) {
  const s = m?.scope ?? { all: false, domains: [], addresses: [] };
  const form = h(`<div class="form">
    <label class="field-label">邮箱</label><input class="input" data-email type="email" value="${esc(m?.email ?? "")}" placeholder="成员用来登录的邮箱" />
    <label class="field-label">姓名（可选）</label><input class="input" data-name value="${esc(m?.name ?? "")}" />
    <label class="field-label">可以访问</label>
    <label class="chk"><input type="checkbox" data-all ${s.all ? "checked" : ""}/>全部域名（包括以后新增的）</label>
    <div class="scope-domains pill-list">${store.domains.map((d) => `<label class="pill pick"><input type="checkbox" data-dom="${esc(d.name)}" ${s.domains.includes(d.name) ? "checked" : ""}/>${esc(d.name)}</label>`).join("")}</div>
    <label class="field-label">或者只授权具体地址（每行一个）</label>
    <textarea class="input area" data-addrs rows="3" placeholder="sales@example.com">${esc(s.addresses.join("\n"))}</textarea>
    ${m ? `<label class="chk"><input type="checkbox" data-disabled ${m.disabled ? "checked" : ""}/>停用这个成员（立即退出登录）</label>` : ""}
  </div>`);
  const sync = () => form.querySelector(".scope-domains").classList.toggle("dim", form.querySelector("[data-all]").checked);
  form.querySelector("[data-all]").onchange = sync;
  sync();
  modal({
    title: m ? "编辑成员" : "添加成员",
    body: form,
    wide: true,
    actions: [
      { label: "取消" },
      {
        label: "保存",
        kind: "primary",
        onClick: async () => {
          const id = m?.id ?? crypto.randomUUID();
          await api(`/members/${id}`, {
            method: "PUT",
            body: {
              email: form.querySelector("[data-email]").value,
              name: form.querySelector("[data-name]").value,
              scope: {
                all: form.querySelector("[data-all]").checked,
                domains: [...form.querySelectorAll("[data-dom]:checked")].map((i) => i.dataset.dom),
                addresses: form.querySelector("[data-addrs]").value.split(/[\s,;]+/).filter(Boolean),
              },
              disabled: form.querySelector("[data-disabled]")?.checked ?? false,
            },
          });
          if (!m && (await confirmDialog({ title: "成员已添加", message: "现在给他发送登录链接吗？", confirmLabel: "发送" }))) {
            await api(`/members/${id}/invite`, { body: {} }).then(() => toast("登录链接已发送", { type: "success" })).catch(toastError);
          }
          done();
        },
      },
    ],
  });
}

// ---------- 数据 ----------
// 免绑卡模式：D1 / KV 的用量对照免费额度
function liteCard(l) {
  const bar = (used, cap, label, note) => {
    const pct = Math.min(100, (used / cap) * 100);
    return `<div class="usage-row"><span>${label}</span><div class="bar ${pct > 85 ? "warn" : ""}"><i style="width:${Math.max(1, pct)}%"></i></div>
      <span class="muted small">${fmtSize(used)} / ${fmtSize(cap)}${note ? ` · ${note}` : ""}</span></div>`;
  };
  return `<section class="set-card">
    <div class="set-row"><div><b>存储方式：免绑卡模式</b><span>账户没有开通 R2，邮件正文和小文件存在 D1，大附件存在 KV（都不需要绑卡）。开通 R2（免费 10 GB，需要绑卡）后可以获得更大空间。</span></div><span class="status ok">D1 + KV</span></div>
    <div class="usage">
      ${bar(l.d1Bytes, 500 * 1024 * 1024, l.separateDb ? "D1 存储库" : "D1 主数据库", l.separateDb ? "" : "与邮件元数据共用")}
      ${l.hasKv ? bar(l.kvBytes, 1024 * 1024 * 1024, "KV", "大于 512 KB 的文件") : `<div class="notice warn sm">${icon("alert")}<span>没有绑定 KV：大于 512 KB 的附件会保存失败。</span></div>`}
    </div>
  </section>`;
}

async function data(body) {
  const info = await load("/storage");
  const stats = info.domains;
  const total = stats.reduce((a, b) => ({ n: a.n + b.n, bytes: a.bytes + b.bytes }), { n: 0, bytes: 0 });
  body.innerHTML = `
    ${info.lite ? liteCard(info.lite) : ""}
    <section class="set-card">
      <div class="set-row"><div><b>存储用量</b><span>${
        info.mode === "lite" ? "邮件元数据和正文在 D1，大附件在 KV" : "邮件元数据在 D1，正文和附件在 R2"
      }，都在你自己的 Cloudflare 账户里。</span></div><span class="big-num">${fmtSize(total.bytes)}<small>${total.n} 封</small></span></div>
      <div class="usage">${stats
        .map(
          (s) => `<div class="usage-row"><span>${esc(s.domain)}</span><div class="bar"><i style="width:${total.bytes ? Math.max(2, (s.bytes / total.bytes) * 100) : 0}%"></i></div>
          <span class="muted small">${fmtSize(s.bytes)} · ${s.n} 封${s.trash ? ` · 垃圾箱 ${s.trash}` : ""}${s.spam ? ` · 垃圾 ${s.spam}` : ""}</span></div>`,
        )
        .join("")}</div>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>导出邮件</b><span>导出为标准 mbox 格式，可以导入 Thunderbird、Apple Mail 等客户端。每个文件最多 300 封。</span></div></div>
      <div class="form-inline"><select class="mini-select" data-scope><option value="">全部域名</option>${stats.map((s) => `<option value="${esc(s.domain)}">${esc(s.domain)}</option>`).join("")}</select>
        <button class="btn primary" data-export>${icon("download")}准备导出</button></div>
      <div class="export-parts"></div>
    </section>`;
  body.querySelector("[data-export]").onclick = async () => {
    const domain = body.querySelector("[data-scope]").value;
    const q = domain ? `domain=${encodeURIComponent(domain)}` : "";
    const info = await api(`/export?${q}`).catch(toastError);
    if (!info) return;
    body.querySelector(".export-parts").innerHTML = info.total
      ? `<div class="set-sub"><b>${info.total} 封邮件，共 ${info.pages} 个文件</b><div class="pill-list">${Array.from({ length: info.pages }, (_, i) => `<a class="pill link" href="/api/export.mbox?${q}&page=${i}" download>${icon("download")}第 ${i * info.pageSize + 1}–${Math.min(info.total, (i + 1) * info.pageSize)} 封</a>`).join("")}</div></div>`
      : `<div class="set-empty muted">没有可导出的邮件。</div>`;
  };
}

// ---------- 账户与安全 ----------
async function account(body) {
  const a = await load("/account");
  const pk = passkeySupported();
  body.innerHTML = `
    <section class="set-card">
      <div class="set-row"><div><b>管理员密码</b><span>${a.hasPassword ? "用于在登录页登录。修改后，其他设备上的登录会自动退出。" : "还没有设置密码。设置后可以不经过 Cloudflare 直接登录。"}</span></div>
        <span class="status ${a.hasPassword ? "ok" : "off"}">${a.hasPassword ? "已设置" : "未设置"}</span></div>
      <form class="set-sub pw-form" novalidate>
        ${a.hasPassword ? `<input class="input" type="password" name="current" autocomplete="current-password" placeholder="当前密码" aria-label="当前密码" />` : ""}
        <input class="input" type="password" name="next" autocomplete="new-password" placeholder="新密码（至少 10 位）" aria-label="新密码" />
        <input class="input" type="password" name="next2" autocomplete="new-password" placeholder="再输入一次" aria-label="再输入一次新密码" />
        <div><button class="btn primary" type="submit">${a.hasPassword ? "修改密码" : "设置密码"}</button></div>
      </form>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>通行密钥</b><span>${pk ? "用指纹、面容或设备密码登录，比密码更安全，也不怕钓鱼网站。每台设备可以分别添加。" : "这个浏览器不支持通行密钥"}</span></div>
        ${pk ? `<button class="btn primary sm" data-add-passkey>${icon("plus")}添加通行密钥</button>` : ""}</div>
      ${
        a.passkeys.length
          ? `<div class="id-list">${a.passkeys
              .map(
                (p) => `<div class="id-row"><span class="id-ic">${icon("key")}</span>
              <div class="id-main"><b>${esc(p.name || "通行密钥")}</b><span class="muted small">添加于 ${fmtRelative(p.created_at)}${p.last_used_at ? ` · 最近使用 ${fmtRelative(p.last_used_at)}` : ""}</span></div>
              <button class="icon-btn sm" data-del-passkey="${esc(p.id)}" aria-label="删除">${icon("trash")}</button></div>`,
              )
              .join("")}</div>`
          : ""
      }
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>Cloudflare API 令牌</b><span>用于列出域名、配置收件和发件。只保存在你的数据库里（加密）。权限不够或令牌被撤销时，可以在这里更换。</span></div>
        <span class="status ${a.cfToken ? "ok" : "off"}">${a.cfToken ? "已连接" : "未设置"}</span></div>
      <form class="set-sub token-form" novalidate>
        <input class="input" type="password" name="token" autocomplete="off" spellcheck="false" placeholder="粘贴新的 API 令牌" aria-label="API 令牌" />
        <div class="form-inline"><button class="btn primary" type="submit">${a.cfToken ? "更换令牌" : "保存令牌"}</button>
          <a class="btn ghost" href="${tokenTemplateUrl()}" target="_blank" rel="noopener">${icon("external")}在 Cloudflare 创建令牌</a></div>
        <details class="perm-list"><summary>需要的权限</summary>${tokenPermsHtml()}</details>
      </form>
    </section>
    <section class="set-card">
      <div class="set-row"><div><b>Cloudflare OAuth 登录（可选）</b><span>${
        a.oauthConfigured ? "已配置：登录页会显示「使用 Cloudflare 登录」。" : "未配置。需要的话，按 README 创建私有 OAuth 客户端并添加两个 Secret 即可。"
      }</span></div><span class="status ${a.oauthConfigured ? "ok" : "off"}">${a.oauthConfigured ? "已配置" : "未配置"}</span></div>
    </section>`;
  const refresh = () => {
    cache.delete("/account");
    account(body);
  };
  const pw = body.querySelector(".pw-form");
  pw.onsubmit = async (e) => {
    e.preventDefault();
    if (pw.next.value !== pw.next2.value) return toast("两次输入的密码不一致", { type: "error" });
    try {
      await api("/account/password", { method: "PUT", body: { current: pw.current?.value, next: pw.next.value } });
      toast("密码已更新", { type: "success" });
      refresh();
    } catch (err) {
      toastError(err);
    }
  };
  body.querySelector("[data-add-passkey]")?.addEventListener("click", async () => {
    const name = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone / iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : /Android/.test(navigator.userAgent) ? "Android" : /Windows/.test(navigator.userAgent) ? "Windows" : "这台设备";
    try {
      await addPasskey(name);
      toast("已添加通行密钥", { type: "success" });
      refresh();
    } catch (err) {
      toastError(err);
    }
  });
  body.querySelectorAll("[data-del-passkey]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog({ title: "删除这个通行密钥？", message: "删除后这台设备不能再用通行密钥登录。", confirmLabel: "删除", danger: true }))) return;
        await api(`/account/passkeys/${encodeURIComponent(b.dataset.delPasskey)}`, { method: "DELETE" }).catch(toastError);
        refresh();
      }),
  );
  const tf = body.querySelector(".token-form");
  tf.onsubmit = async (e) => {
    e.preventDefault();
    const t = toast("正在检查令牌…", { type: "loading", duration: 0 });
    try {
      const r = await api("/account/cf-token", { method: "PUT", body: { token: tf.token.value } });
      t.close();
      toast("令牌已更新", { type: "success" });
      for (const w of r.warnings || []) toast(w, { type: "info", duration: 8000 });
      refresh();
    } catch (err) {
      t.close();
      toastError(err);
    }
  };
}

// ---------- 快捷键 ----------
export const SHORTCUTS = [
  ["导航", [["j / k", "下一个 / 上一个会话"], ["u 或 Esc", "返回列表"], ["/", "搜索"], ["g 然后 i", "收件箱"], ["g 然后 s", "星标"], ["g 然后 t", "已发送"], ["g 然后 d", "草稿"], ["g 然后 b", "稍后提醒"]]],
  ["操作", [["c", "写邮件"], ["r", "回复"], ["a", "全部回复"], ["f", "转发"], ["e", "归档"], ["#", "删除"], ["!", "报告垃圾邮件"], ["s", "星标"], ["b", "稍后提醒"], ["l", "标签"], ["Shift + U", "标为未读"], ["x", "选中当前会话"]]],
  ["写信", [["⌘/Ctrl + Enter", "发送"], ["⌘/Ctrl + K", "插入链接"], ["Esc", "最小化写信窗口"]]],
];

function shortcuts(body) {
  body.innerHTML = `<section class="set-card shortcuts">${shortcutsHtml()}</section>`;
}
function shortcutsHtml() {
  return SHORTCUTS.map(
    ([g, items]) =>
      `<div class="sc-group"><h4>${g}</h4>${items.map(([k, d]) => `<div class="sc-row"><span>${d}</span><span>${k.split(" ").map((x) => (["然后", "或", "+", "/"].includes(x) ? `<span class="muted">${x}</span>` : `<kbd>${esc(x)}</kbd>`)).join(" ")}</span></div>`).join("")}</div>`,
  ).join("");
}

export function shortcutsModal() {
  modal({ title: "键盘快捷键", body: `<div class="shortcuts">${shortcutsHtml()}</div>`, wide: true });
}
