// 文件存储（邮件正文、原始邮件、附件、上传、头像缓存）
// - 绑定了 R2（MAIL）：直接用 R2
// - 没有 R2（账户没绑卡开不了 R2）：免绑卡模式——小文件存 D1（BLOBS 库，没有就用主库），大文件存 KV
//   D1 单行最多 2 MB；KV 免费版每天只能写 1000 次，所以只把大文件放进 KV，普通邮件一次 KV 写入都不用。
//   免费版每次请求只有 10ms CPU：大文件不做 base64 转换，直接从 KV 读取。
// 接口与 R2 保持一致（只用到的那部分），调用处不需要关心底层是哪种存储。
import type { Env } from "./env";

export interface ObjectInfo {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
export interface StoredObject extends ObjectInfo {
  readonly body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}
export interface PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
export interface BlobStore {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, opts?: PutOptions): Promise<unknown>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: ObjectInfo[]; truncated: boolean; cursor?: string }>;
}

export type StorageMode = "r2" | "lite";
export const storageMode = (env: Env): StorageMode => (env.MAIL ? "r2" : "lite");

export function blobs(env: Env): BlobStore {
  return env.MAIL ? (env.MAIL as unknown as BlobStore) : new LiteStore(env);
}

// ---------- 免绑卡模式 ----------
const D1_TEXT_MAX = 1_900_000; // D1 单行上限 2,000,000 字节，留一点余量
const D1_BINARY_MAX = 512 * 1024; // 二进制转 base64 存 D1 的上限，再大就放 KV（base64 转换耗 CPU）
const schemaReady = new WeakMap<D1Database, Promise<unknown>>();

interface Row {
  key: string;
  size: number;
  type: string | null;
  custom: string | null;
  loc: "d1" | "kv";
  enc: "utf8" | "b64" | null;
  created_at: number;
  data: string | null;
}

class LiteStore implements BlobStore {
  private db: D1Database;
  private kv?: KVNamespace;
  constructor(env: Env) {
    this.db = env.BLOBS ?? env.DB;
    this.kv = env.KV;
  }

  private ready(): Promise<unknown> {
    let p = schemaReady.get(this.db);
    if (!p) {
      p = this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT, custom TEXT,
            loc TEXT NOT NULL, enc TEXT, created_at INTEGER NOT NULL, data TEXT)`,
        )
        .run()
        .catch((e) => {
          schemaReady.delete(this.db);
          throw e;
        });
      schemaReady.set(this.db, p);
    }
    return p;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, opts: PutOptions = {}): Promise<void> {
    await this.ready();
    let loc: Row["loc"] = "d1";
    let enc: Row["enc"] = "utf8";
    let data: string | null;
    let size: number;
    if (typeof value === "string") {
      size = new TextEncoder().encode(value).byteLength;
      data = value;
    } else {
      const bytes = toBytes(value);
      size = bytes.byteLength;
      // 纯 ASCII（大多数邮件原文）直接当文本存，不用 base64
      if (size <= D1_TEXT_MAX && isAscii(bytes)) data = new TextDecoder().decode(bytes);
      else if (size <= D1_BINARY_MAX) ((data = toBase64(bytes)), (enc = "b64"));
      else ((data = null), (loc = "kv"), (enc = null));
      if (loc === "kv") {
        if (!this.kv) throw new Error("免绑卡模式下大于 512 KB 的文件需要 KV 存储，请在 wrangler 配置中绑定 KV（binding: KV）");
        await this.kv.put(key, bytes);
      }
    }
    if (loc === "d1" && size > D1_TEXT_MAX) {
      // 特别大的文本（例如超大的 HTML 正文）也放 KV
      if (!this.kv) throw new Error("文件太大，免绑卡模式需要绑定 KV");
      await this.kv.put(key, data!);
      ((loc = "kv"), (enc = null), (data = null));
    }
    await this.db
      .prepare("INSERT OR REPLACE INTO blobs (key, size, type, custom, loc, enc, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(key, size, opts.httpMetadata?.contentType ?? null, opts.customMetadata ? JSON.stringify(opts.customMetadata) : null, loc, enc, Date.now(), data)
      .run();
  }

  async get(key: string): Promise<StoredObject | null> {
    await this.ready();
    const row = await this.db.prepare("SELECT key, size, type, custom, loc, enc, created_at, data FROM blobs WHERE key = ?").bind(key).first<Row>();
    if (!row) return null;
    const info = toInfo(row);
    if (row.loc === "kv") {
      // KV 是最终一致的：刚写入时其他地区可能要几十秒才能读到
      const stream = await this.kv?.get(key, "stream");
      if (!stream) return null;
      return makeObject(info, () => stream);
    }
    if (row.enc === "b64") {
      const bytes = fromBase64(row.data ?? "");
      return makeObject(info, () => new Response(bytes).body!, async () => bytes.buffer as ArrayBuffer);
    }
    const text = row.data ?? "";
    return makeObject(info, () => new Response(text).body!, async () => new TextEncoder().encode(text).buffer as ArrayBuffer, async () => text);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    await this.ready();
    const row = await this.db.prepare("SELECT key, size, type, custom, loc, created_at FROM blobs WHERE key = ?").bind(key).first<Row>();
    return row ? toInfo(row) : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    await this.ready();
    const list = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < list.length; i += 90) {
      const part = list.slice(i, i + 90);
      const marks = part.map(() => "?").join(",");
      const { results } = await this.db.prepare(`SELECT key FROM blobs WHERE loc = 'kv' AND key IN (${marks})`).bind(...part).all<{ key: string }>();
      if (results.length && this.kv) await Promise.all(results.map((r) => this.kv!.delete(r.key)));
      await this.db.prepare(`DELETE FROM blobs WHERE key IN (${marks})`).bind(...part).run();
    }
  }

  async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
    await this.ready();
    const { results } = await this.db
      .prepare("SELECT key, size, type, custom, loc, created_at FROM blobs WHERE key > ? AND key >= ? AND key < ? ORDER BY key LIMIT ?")
      .bind(cursor ?? "", prefix, prefix + "￿", limit)
      .all<Row>();
    const truncated = results.length === limit;
    return { objects: results.map(toInfo), truncated, cursor: truncated ? results[results.length - 1].key : undefined };
  }
}

// 免绑卡模式的用量（设置页显示）
export async function liteUsage(env: Env): Promise<{ d1Bytes: number; kvBytes: number; separateDb: boolean; hasKv: boolean }> {
  const db = env.BLOBS ?? env.DB;
  const row = await db
    .prepare("SELECT COALESCE(SUM(CASE WHEN loc = 'd1' THEN LENGTH(data) ELSE 0 END), 0) AS d1, COALESCE(SUM(CASE WHEN loc = 'kv' THEN size ELSE 0 END), 0) AS kv FROM blobs")
    .first<{ d1: number; kv: number }>()
    .catch(() => null);
  return { d1Bytes: row?.d1 ?? 0, kvBytes: row?.kv ?? 0, separateDb: Boolean(env.BLOBS), hasKv: Boolean(env.KV) };
}

function toInfo(row: Row): ObjectInfo {
  return {
    key: row.key,
    size: row.size,
    uploaded: new Date(row.created_at),
    httpMetadata: row.type ? { contentType: row.type } : {},
    customMetadata: row.custom ? JSON.parse(row.custom) : {},
  };
}

function makeObject(
  info: ObjectInfo,
  stream: () => ReadableStream,
  buffer?: () => Promise<ArrayBuffer>,
  text?: () => Promise<string>,
): StoredObject {
  const ab = buffer ?? (() => new Response(stream()).arrayBuffer());
  const tx = text ?? (async () => new TextDecoder().decode(await ab()));
  return {
    ...info,
    get body() {
      return stream();
    },
    arrayBuffer: ab,
    text: tx,
    json: async <T>() => JSON.parse(await tx()) as T,
  };
}

function toBytes(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function isAscii(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] > 0x7e || (b[i] < 0x20 && b[i] !== 9 && b[i] !== 10 && b[i] !== 13)) return false;
  return true;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
