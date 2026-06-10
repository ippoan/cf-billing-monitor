// Flickr パイプライン日次レポート — rust-flickr GET /stats を消費して
// 撮影日別の登録/upload/検証と残数をメール化する。Refs #4
import { createMimeMessage } from "mimetext";

export interface DayStat {
  date: string;
  files: number;
  uploaded: number;
  verified: number;
}

export interface FlickrStats {
  days: DayStat[];
  total_unuploaded: number;
  total_unverified: number;
  /** 最古の未アップロード撮影日 (YYYYMMDD)。日々進む = backfill が SD ローテーションに勝っている */
  oldest_unuploaded_date?: string | null;
}

export interface FlickrReportEnv {
  RUST_FLICKR_URL: string;
  FLICKR_REPORT_ORG: string;
}

export async function fetchFlickrStats(env: FlickrReportEnv): Promise<FlickrStats> {
  const base = env.RUST_FLICKR_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/stats?days=7`, {
    headers: { "x-organization-id": env.FLICKR_REPORT_ORG },
  });
  if (!res.ok) {
    throw new Error(`flickr stats fetch failed: ${res.status}`);
  }
  return (await res.json()) as FlickrStats;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** YYYYMMDD → YYYY-MM-DD (想定外の形式はそのまま返す) */
function fmtDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

const S = {
  table:
    'style="border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px"',
  th: 'style="text-align:left;padding:6px 10px;background:#f5f5f5;border-bottom:2px solid #ddd;font-weight:600;white-space:nowrap"',
  thR: 'style="text-align:right;padding:6px 10px;background:#f5f5f5;border-bottom:2px solid #ddd;font-weight:600;white-space:nowrap"',
  td: 'style="padding:5px 10px;border-bottom:1px solid #eee;white-space:nowrap"',
  tdR: 'style="text-align:right;padding:5px 10px;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums;white-space:nowrap"',
  summary:
    'style="background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;padding:12px 16px;margin:12px 0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px"',
};

export function buildFlickrHtmlBody(stats: FlickrStats): string {
  const rows = stats.days
    .map(
      (d) =>
        `<tr><td ${S.td}>${fmtDate(d.date)}</td><td ${S.tdR}>${fmt(d.files)}</td><td ${S.tdR}>${fmt(d.uploaded)}</td><td ${S.tdR}>${fmt(d.verified)}</td></tr>`,
    )
    .join("");
  const oldest = stats.oldest_unuploaded_date
    ? ` (最古: <b>${fmtDate(stats.oldest_unuploaded_date)}</b> — 古い順に消化中)`
    : "";
  return `
<div ${S.summary}>
  未アップロード残: <b>${fmt(stats.total_unuploaded)}</b>${oldest} / 未検証残: <b>${fmt(stats.total_unverified)}</b>
</div>
<table ${S.table}>
  <tr><th ${S.th}>撮影日</th><th ${S.thR}>登録</th><th ${S.thR}>Flickr済</th><th ${S.thR}>検証済</th></tr>
  ${rows}
</table>`;
}

export function buildFlickrEmail(
  stats: FlickrStats,
  dateStr: string,
): { subject: string; raw: string } {
  const latest = stats.days[0];
  const headline = latest
    ? `${fmtDate(latest.date)}: ${fmt(latest.files)} files`
    : "no data";
  const subject = `[Flickr] ${dateStr} ${headline} / 残 ${fmt(stats.total_unuploaded)}`;

  const msg = createMimeMessage();
  msg.setSender({ name: "Flickr Report", addr: "flickr-report@mtamaramu.com" });
  msg.setRecipient("m.tama.ramu@gmail.com");
  msg.setSubject(subject);
  msg.addMessage({
    contentType: "text/html",
    data: buildFlickrHtmlBody(stats),
  });

  return { subject, raw: msg.asRaw() };
}
