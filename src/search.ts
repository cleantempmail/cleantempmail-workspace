// 全文搜索：SQLite FTS5 + 中日韩文字按字切分
// unicode61 分词器会把一整串中文当成一个词，搜"简历"匹配不到"简历与作品集"。
// 所以写入和查询前都在每个 CJK 字两边加空格，查询时用短语匹配保证相邻。
import type { Env } from "./env";

const CJK = /([぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ｦ-ﾟ])/g;
const HAS_CJK = new RegExp(CJK.source);
export const ftsText = (s: string | null | undefined) => (s ?? "").replace(CJK, " $1 ").replace(/\s+/g, " ").trim();

const BODY_LIMIT = 20000;

export async function indexMessage(
  env: Env,
  rowid: number,
  m: { subject: string; people: string; body: string },
): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO messages_fts (rowid, subject, people, body) VALUES (?, ?, ?, ?)")
    .bind(rowid, ftsText(m.subject), ftsText(m.people), ftsText(m.body.slice(0, BODY_LIMIT)))
    .run();
}

export function peopleText(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ").replace(/[<>"\[\]{}]/g, " ");
}

// 把一个词变成 FTS5 查询片段
function ftsTerm(term: string): string | null {
  const t = term.replace(/["*^:()]/g, " ").trim();
  if (!t) return null;
  if (HAS_CJK.test(t)) return `"${ftsText(t)}"`;
  // 英文/数字：前缀匹配，每个单词都要出现
  return t
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(" ");
}

export interface ParsedSearch {
  fts: string | null; // FTS5 MATCH 表达式
  where: string[]; // 作用在 messages 表上的附加条件
  args: unknown[];
  scope: "live" | "trash" | "spam" | "all";
  folder: "inbox" | "sent" | null;
  text: string; // 原始的自由文本（用于高亮）
}

// 支持：from: to: subject: has:attachment is:unread is:starred in:inbox|sent|trash|spam|archive before: after: "短语"
export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { fts: null, where: [], args: [], scope: "live", folder: null, text: "" };
  const free: string[] = [];
  const re = /(\w+):("([^"]*)"|\S+)|"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const [, key, , quotedVal, phrase, word] = m;
    const val = (quotedVal ?? m[2] ?? "").trim();
    if (key) {
      const k = key.toLowerCase();
      const v = val.toLowerCase();
      if (k === "from") (out.where.push("(lower(from_addr) LIKE ? OR from_name LIKE ?)"), out.args.push(`%${v}%`, `%${val}%`));
      else if (k === "to") (out.where.push("(lower(to_addrs) LIKE ? OR lower(cc_addrs) LIKE ? OR mailbox LIKE ?)"), out.args.push(`%${v}%`, `%${v}%`, `%${v}%`));
      else if (k === "subject") (out.where.push("subject LIKE ?"), out.args.push(`%${val}%`));
      else if (k === "has" && /^(attachment|附件|file)$/.test(v)) out.where.push("has_attachments = 1");
      else if (k === "is" && /^(unread|未读)$/.test(v)) out.where.push("folder = 'inbox' AND is_read = 0");
      else if (k === "is" && /^(starred|星标)$/.test(v)) out.where.push("starred = 1");
      else if (k === "in" && /^(trash|垃圾箱)$/.test(v)) out.scope = "trash";
      else if (k === "in" && /^(spam|垃圾邮件)$/.test(v)) out.scope = "spam";
      else if (k === "in" && /^(all|全部)$/.test(v)) out.scope = "all";
      else if (k === "in" && /^(sent|已发送)$/.test(v)) out.folder = "sent";
      else if (k === "in" && /^(inbox|收件箱)$/.test(v)) out.folder = "inbox";
      else if (k === "in" && /^(archive|归档)$/.test(v)) out.where.push("archived = 1");
      else if ((k === "before" || k === "after") && !Number.isNaN(Date.parse(val))) {
        out.where.push(`created_at ${k === "before" ? "<" : ">="} ?`);
        out.args.push(Math.floor(Date.parse(val) / 1000));
      } else free.push(m[0]); // 不认识的 key:value 当普通文本
    } else free.push(phrase ?? word ?? "");
  }
  out.text = free.join(" ").trim();
  const terms = free.map(ftsTerm).filter(Boolean) as string[];
  if (terms.length) out.fts = terms.join(" AND ");
  return out;
}
