// 导入邮件：浏览器里把 mbox 拆成单封邮件，逐封上传到 /api/import（.eml 文件直接上传）。
// 文件可能有好几 GB：按流读取，不会一次读进内存。服务端按 Message-ID 去重，中断后重新导入同一个文件会跳过已导入的。

const FROM = [10, 70, 114, 111, 109, 32]; // "\nFrom "
// mbox 分隔行："From sender@example.com Mon Jan  1 00:00:00 2024"
const SEP_LINE = /^From \S*\s+\S{3}\s+\S{3}\s+\d{1,2}\s+\d{1,2}:\d{2}/;

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOfSeq(buf, seq, from) {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

const lineAt = (buf, i) => {
  let end = i;
  while (end < buf.length && end - i < 200 && buf[end] !== 10) end++;
  return String.fromCharCode(...buf.subarray(i, end));
};

// 去掉开头的 "From " 分隔行，还原 mboxrd 转义的 ">From "
function cleanMessage(buf) {
  let start = 0;
  if (lineAt(buf, 0).startsWith("From ")) {
    while (start < buf.length && buf[start] !== 10) start++;
    start++;
  }
  const body = buf.subarray(start);
  const out = new Uint8Array(body.length);
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    if ((i === 0 || body[i - 1] === 10) && body[i] === 62) {
      let j = i;
      while (body[j] === 62) j++;
      if (body[j] === 70 && body[j + 1] === 114 && body[j + 2] === 111 && body[j + 3] === 109 && body[j + 4] === 32) continue; // 去掉一个 ">"
    }
    out[n++] = body[i];
  }
  let end = n;
  while (end > 0 && (out[end - 1] === 10 || out[end - 1] === 13)) end--;
  return out.subarray(0, end);
}

export async function* mboxMessages(file) {
  const reader = file.stream().getReader();
  let pending = new Uint8Array(0);
  let scan = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) pending = concat(pending, value);
    for (;;) {
      const i = indexOfSeq(pending, FROM, scan);
      if (i < 0) {
        scan = Math.max(0, pending.length - FROM.length);
        break;
      }
      const blankBefore = i > 0 && (pending[i - 1] === 10 || (pending[i - 1] === 13 && pending[i - 2] === 10));
      if (blankBefore || SEP_LINE.test(lineAt(pending, i + 1))) {
        const msg = cleanMessage(pending.subarray(0, i));
        if (msg.length) yield msg;
        pending = pending.subarray(i + 1);
        scan = 1;
      } else scan = i + 1;
    }
    if (done) break;
  }
  const last = cleanMessage(pending);
  if (last.length) yield last;
}

async function* allMessages(files) {
  for (const f of files) {
    if (/\.eml$/i.test(f.name) || f.type === "message/rfc822") yield { bytes: new Uint8Array(await f.arrayBuffer()), file: f.name };
    else for await (const bytes of mboxMessages(f)) yield { bytes, file: f.name };
  }
}

// 逐封上传（同时最多 3 封）。onProgress({ done, stored, duplicate, skipped, failed, lastError })
export async function importFiles(files, { mailbox = "", markRead = true, signal, onProgress }) {
  const st = { done: 0, stored: 0, duplicate: 0, skipped: 0, failed: 0, lastError: "", stopped: "" };
  const q = new URLSearchParams({ read: markRead ? "1" : "0", ...(mailbox ? { mailbox } : {}) });
  const upload = async (bytes) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`/api/import?${q}`, { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: bytes, signal }).catch((e) => e);
      if (res instanceof Error) {
        if (signal?.aborted) throw res;
        if (attempt < 2) continue;
        throw new Error("网络错误");
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data.status;
      if (res.status === 401) throw Object.assign(new Error("登录已过期，请刷新页面后重新导入"), { fatal: true });
      // 单封邮件的问题（太大、找不到收件地址）：跳过这一封
      if (res.status === 413 || res.status === 422 || res.status === 400) return Object.assign(new Error(data.error || `请求失败（${res.status}）`), { skip: true });
      if (attempt < 2 && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      // 多半是当天的额度用完了：停下来，明天再导入同一个文件即可
      throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { fatal: true });
    }
  };
  const inflight = new Set();
  try {
    for await (const { bytes } of allMessages(files)) {
      if (signal?.aborted) break;
      const p = upload(bytes)
        .then((r) => {
          if (r instanceof Error) {
            st.skipped++;
            st.lastError = r.message;
          } else if (r === "duplicate") st.duplicate++;
          else st.stored++;
        })
        .catch((e) => {
          if (signal?.aborted) return;
          st.failed++;
          st.lastError = e.message;
          if (e.fatal) st.stopped = e.message;
        })
        .finally(() => {
          st.done++;
          inflight.delete(p);
          onProgress?.({ ...st });
        });
      inflight.add(p);
      if (inflight.size >= 3) await Promise.race(inflight);
      if (st.stopped) break;
    }
    await Promise.all(inflight);
  } finally {
    onProgress?.({ ...st, finished: true });
  }
  return st;
}
