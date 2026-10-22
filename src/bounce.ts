// 退信识别：解析投递失败通知（RFC 3464），把结果关联回原来那封发出的邮件
import type { Email } from "postal-mime";

export interface BounceInfo {
  recipient: string | null;
  status: string | null; // 例如 5.1.1
  diagnostic: string | null;
  originalMessageId: string | null;
  permanent: boolean;
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail-daemon|cf-bounce|bounce)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery failure|mail delivery failed|returned mail|failure notice|could not be delivered|退信|未能送达|投递失败|无法投递|系统退信)/i;

const td = new TextDecoder();
const asText = (c: unknown) => (typeof c === "string" ? c : c instanceof ArrayBuffer ? td.decode(c) : ArrayBuffer.isView(c) ? td.decode(c as Uint8Array) : "");

export function detectBounce(parsed: Email, envelopeFrom: string, contentType: string | null): BounceInfo | null {
  const from = `${parsed.from?.address ?? ""} ${envelopeFrom}`;
  const isReport = /multipart\/report/i.test(contentType ?? "") && /delivery-status/i.test(contentType ?? "");
  if (!isReport && !(BOUNCE_FROM.test(from) && BOUNCE_SUBJECT.test(parsed.subject ?? ""))) return null;

  let dsn = "";
  let origHeaders = "";
  for (const a of parsed.attachments) {
    const t = a.mimeType.toLowerCase();
    if (t === "message/delivery-status" || t === "message/global-delivery-status") dsn += "\n" + asText(a.content);
    else if (t === "message/rfc822" || t === "text/rfc822-headers" || t === "message/rfc822-headers") origHeaders += "\n" + asText(a.content).slice(0, 20000);
  }
  const body = parsed.text ?? "";
  const src = dsn || body;
  const recipient =
    src.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i)?.[1] ??
    src.match(/Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i)?.[1] ??
    body.match(/<([^\s<>@]+@[^\s<>]+)>[^\n]*(?:\n[^\n]*)?(?:does not exist|user unknown|not found|rejected|无法|不存在)/i)?.[1] ??
    null;
  const status = src.match(/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1] ?? null;
  const diagnostic = (src.match(/^Diagnostic-Code:\s*(?:smtp;\s*)?(.+(?:\n[ \t].+)*)/im)?.[1] ?? body.match(/(5\d\d[ -][^\n]{5,200})/)?.[1] ?? null)?.replace(/\s+/g, " ").trim().slice(0, 300) ?? null;
  const originalMessageId =
    (origHeaders || body).match(/^Message-ID:\s*(<[^>\s]+>)/im)?.[1] ??
    parsed.inReplyTo?.match(/<[^>\s]+>/)?.[0] ??
    null;
  const permanent = status ? status.startsWith("5") : !/(temporar|deferred|delayed|延迟)/i.test(body);
  return { recipient: recipient?.toLowerCase() ?? null, status, diagnostic, originalMessageId, permanent };
}
