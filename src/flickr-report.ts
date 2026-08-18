// Flickr パイプライン日次レポート — cf-flickr-cam-worker の binding-only RPC
// (`ReportEntrypoint.dailyStats`) を消費して撮影日別の登録/upload と残数を
// メール化する。Refs #4, #18
//
// 供給元は 2026-07-08 まで rust-flickr (Cloud Run) の `GET /stats` だったが、
// カメラ→Flickr パイプラインが ippoan/cf-flickr-cam-worker へ移行して Cloud Run
// が廃止されたため RPC に付け替えた (旧 URL は Google フロントの 404 を返し、
// レポートが無音で止まっていた)。新パイプラインには verify 相当の工程が無いので
// 旧レポートの「検証済 / 未検証残」は無い。
import { createMimeMessage } from "mimetext";

/** 1 撮影日ぶんの登録/アップロード件数 (cf-flickr-cam-worker `src/stats.ts` と同形)。 */
export interface DayStat {
  date: string;
  files: number;
  uploaded: number;
}

export interface FlickrStats {
  /** 撮影日の新しい順。 */
  days: DayStat[];
  /** cam worker の D1 に残っている未アップロード件数 (= 次の cron が拾う残作業)。 */
  pending: number;
}

/** cf-flickr-cam-worker の named entrypoint (`ReportEntrypoint`) への service binding。 */
export interface FlickrCamService {
  dailyStats(days: number): Promise<FlickrStats>;
}

export interface FlickrReportEnv {
  FLICKR_CAM: FlickrCamService;
}

/** backfill 消化中も全体が見えるよう 20 日窓 (uploaded 0 の日が見える = 止まった
 * 日に気付ける)。 */
export const FLICKR_REPORT_DAYS = 20;

export async function fetchFlickrStats(env: FlickrReportEnv): Promise<FlickrStats> {
  return await env.FLICKR_CAM.dailyStats(FLICKR_REPORT_DAYS);
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
  alert:
    'style="background:#ffebee;border:1px solid #ef9a9a;border-radius:6px;padding:12px 16px;margin:12px 0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px"',
};

/** 窓内で「登録 > Flickr済」の日の取り残し合計。cam worker が日次アーカイブを
 * 打った後に残った分 = 放っておくと上がらない (pending と違い cron は拾わない)。 */
export function windowShortfall(stats: FlickrStats): number {
  return stats.days.reduce((sum, d) => sum + Math.max(0, d.files - d.uploaded), 0);
}

export function buildFlickrHtmlBody(stats: FlickrStats): string {
  const rows = stats.days
    .map(
      (d) =>
        `<tr><td ${S.td}>${fmtDate(d.date)}</td><td ${S.tdR}>${fmt(d.files)}</td><td ${S.tdR}>${fmt(d.uploaded)}</td></tr>`,
    )
    .join("");
  // 消化位置 = 窓内で最古の「未完了」日 (古い順に処理するため)
  const inWindowOldest = [...stats.days].reverse().find((d) => d.uploaded < d.files);
  const oldest = inWindowOldest
    ? ` (消化位置: <b>${fmtDate(inWindowOldest.date)}</b> — 古い順に処理中)`
    : "";
  return `
<div ${S.summary}>
  処理待ち: <b>${fmt(stats.pending)}</b>${oldest} / 窓内の取り残し: <b>${fmt(windowShortfall(stats))}</b>
</div>
<table ${S.table}>
  <tr><th ${S.th}>撮影日</th><th ${S.thR}>登録</th><th ${S.thR}>Flickr済</th></tr>
  ${rows}
</table>`;
}

function flickrMail(subject: string, html: string): { subject: string; raw: string } {
  const msg = createMimeMessage();
  msg.setSender({ name: "Flickr Report", addr: "flickr-report@mtamaramu.com" });
  msg.setRecipient("m.tama.ramu@gmail.com");
  msg.setSubject(subject);
  msg.addMessage({ contentType: "text/html", data: html });
  return { subject, raw: msg.asRaw() };
}

export function buildFlickrEmail(
  stats: FlickrStats,
  dateStr: string,
): { subject: string; raw: string } {
  const latest = stats.days[0];
  const headline = latest
    ? `${fmtDate(latest.date)}: ${fmt(latest.files)} files`
    : "no data";
  const subject = `[Flickr] ${dateStr} ${headline} / 残 ${fmt(stats.pending)}`;
  return flickrMail(subject, buildFlickrHtmlBody(stats));
}

/**
 * 集計の取得自体に失敗したときのメール。以前は握り潰して**無音**で止まって
 * いた (2026-07-08〜08-18 の 6 週間、誰も気付かなかった) ため、失敗も必ず 1 通
 * 出す。Refs #18
 */
export function buildFlickrFailureEmail(
  dateStr: string,
  error: unknown,
): { subject: string; raw: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const escaped = detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
  return flickrMail(
    `[Flickr] ${dateStr} 取得失敗 ⚠️`,
    `<div ${S.alert}>
  cf-flickr-cam-worker (<code>ReportEntrypoint.dailyStats</code>) から集計を取得できませんでした。
  <br><br><code>${escaped}</code>
</div>`,
  );
}
