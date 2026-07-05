// GitHub Actions cache 使用量の日次レポート — 収集側 (GitHub Actions workflow が
// `gh cache list` で集計) から POST された内容をメール化する。
// 集計ロジックは送信側 (ippoan/rust-alc-api .github/workflows/cache-size-report.yml)
// に置き、この worker は検証と整形だけを行う (dumb formatter)。
import { createMimeMessage } from "mimetext";

export interface GhCacheReportPayload {
  /** owner/repo (例: ippoan/rust-alc-api) */
  repo: string;
  /** レポート対象日 (JST, YYYY-MM-DD) */
  date: string;
  /** cache 全エントリの合計バイト数 */
  totalBytes: number;
  /** エントリ総数 */
  entryCount: number;
  /** repo の cache size limit (GB)。送信側が知っていれば表示に使う */
  limitGb?: number;
  /** 集計済みの本文 (plain text)。worker 側で HTML escape して <pre> に流す */
  summaryText: string;
}

const MAX_SUMMARY_BYTES = 32 * 1024;

/** 形式検証。不正なら理由の文字列、OK なら null を返す */
export function validateGhCacheReport(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const p = body as Record<string, unknown>;
  if (typeof p.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(p.repo)) return "invalid repo";
  if (typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return "invalid date";
  if (typeof p.totalBytes !== "number" || !Number.isFinite(p.totalBytes) || p.totalBytes < 0)
    return "invalid totalBytes";
  if (typeof p.entryCount !== "number" || !Number.isInteger(p.entryCount) || p.entryCount < 0)
    return "invalid entryCount";
  if (p.limitGb !== undefined && (typeof p.limitGb !== "number" || !Number.isFinite(p.limitGb)))
    return "invalid limitGb";
  if (typeof p.summaryText !== "string") return "invalid summaryText";
  if (new TextEncoder().encode(p.summaryText).length > MAX_SUMMARY_BYTES)
    return "summaryText too large";
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2);
}

export function buildGhCacheReportEmail(p: GhCacheReportPayload): { subject: string; raw: string } {
  const limit = p.limitGb !== undefined ? ` / 上限 ${p.limitGb}GB` : "";
  const subject = `[GH Cache] ${p.repo} ${p.date} 使用量 ${gb(p.totalBytes)}GB${limit} (${p.entryCount} entries)`;

  const summaryStyle =
    'style="background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;padding:12px 16px;margin:12px 0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px"';
  const preStyle =
    'style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:12px;overflow-x:auto;white-space:pre"';
  const html = `
<div ${summaryStyle}>
  <b>${escapeHtml(p.repo)}</b> — GitHub Actions cache <b>${gb(p.totalBytes)}GB</b>${escapeHtml(limit)} / ${p.entryCount} entries
</div>
<pre ${preStyle}>${escapeHtml(p.summaryText)}</pre>`;

  const msg = createMimeMessage();
  msg.setSender({ name: "GH Cache Report", addr: "gh-cache-report@mtamaramu.com" });
  msg.setRecipient("m.tama.ramu@gmail.com");
  msg.setSubject(subject);
  msg.addMessage({ contentType: "text/html", data: html });

  return { subject, raw: msg.asRaw() };
}
