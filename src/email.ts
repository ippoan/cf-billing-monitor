// メール組み立て・送信（HTML テーブル版）
import { createMimeMessage } from "mimetext";
import type { Comparison, MonthToDateUsage } from "./storage";
import type { WorkerMetrics, AccountUsageSummary } from "./graphql";
import type { BillingEntry } from "./billing";
import type { SupabaseUsage } from "./supabase";

interface EmailData {
  date: string;
  workerMetrics: WorkerMetrics[];
  comparison: Comparison;
  monthToDate: { workers: number; r2: number; durableObjects: number; containers: number; supabase: number; total: number };
  monthToDateUsage: MonthToDateUsage;
  billingPeriodUsage: AccountUsageSummary;
  billingHistory: BillingEntry[];
  supabaseUsage: SupabaseUsage | null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtChange(pct: number | null): string {
  if (pct === null) return "-";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function changeColor(pct: number | null): string {
  if (pct === null) return "#666";
  if (pct > 50) return "#d32f2f";
  if (pct > 0) return "#f57c00";
  if (pct < -20) return "#388e3c";
  return "#666";
}

function freeTag(): string {
  return '<span style="background:#e8f5e9;color:#2e7d32;padding:1px 6px;border-radius:3px;font-size:11px">無料枠内</span>';
}

function costCell(cost: number): string {
  if (cost === 0) return freeTag();
  return `<span style="color:#d32f2f;font-weight:600">${fmtCost(cost)}</span>`;
}

const S = {
  table: 'style="width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px"',
  th: 'style="text-align:left;padding:6px 10px;background:#f5f5f5;border-bottom:2px solid #ddd;font-weight:600;white-space:nowrap"',
  thR: 'style="text-align:right;padding:6px 10px;background:#f5f5f5;border-bottom:2px solid #ddd;font-weight:600;white-space:nowrap"',
  td: 'style="padding:5px 10px;border-bottom:1px solid #eee;white-space:nowrap"',
  tdR: 'style="text-align:right;padding:5px 10px;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums;white-space:nowrap"',
  section: 'style="margin:16px 0 8px;font-size:15px;font-weight:700;color:#333;border-left:4px solid #f6821f;padding-left:8px"',
  summary: 'style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:12px 16px;margin:12px 0"',
  alert: 'style="background:#fce4ec;border:1px solid #ef9a9a;border-radius:6px;padding:12px 16px;margin:12px 0;color:#c62828"',
  ok: 'style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;padding:12px 16px;margin:12px 0;color:#2e7d32"',
};

function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function progressBar(used: number, free: number, label: string, valueStr: string): string {
  const pct = free > 0 ? Math.min((used / free) * 100, 100) : 0;
  const pctStr = pct.toFixed(1);
  const barColor = pct > 80 ? "#d32f2f" : pct > 50 ? "#f57c00" : "#43a047";
  return `<tr>
  <td style="padding:4px 10px;width:120px;white-space:nowrap">${label}</td>
  <td style="padding:4px 10px;width:100%">
    <div style="background:#e0e0e0;border-radius:4px;height:18px;position:relative;overflow:hidden">
      <div style="background:${barColor};height:100%;width:${pctStr}%;border-radius:4px;min-width:${pct > 0 ? '2px' : '0'}"></div>
    </div>
  </td>
  <td style="padding:4px 10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:12px">${valueStr}</td>
  <td style="padding:4px 6px;text-align:right;white-space:nowrap;font-weight:600;font-size:13px;color:${barColor}">${pctStr}%</td>
</tr>`;
}

function buildHtmlBody(data: EmailData): string {
  const { date, workerMetrics, comparison, monthToDate, monthToDateUsage, billingPeriodUsage, billingHistory, supabaseUsage } = data;
  const { current, changes, alerts } = comparison;

  const sorted = [...workerMetrics].sort((a, b) => b.requests - a.requests);

  let html = `
<div style="max-width:700px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#333">
<h2 style="color:#333;margin-bottom:4px">Cloudflare 使用量レポート</h2>
<p style="color:#666;margin-top:0">${date}</p>
`;

  // --- 無料枠消費率 ---
  const FREE_REQUESTS = 10_000_000;
  const FREE_CPU_MS = 30_000_000;
  const FREE_R2_CLASS_A = 1_000_000;
  const FREE_R2_CLASS_B = 10_000_000;
  const FREE_DO_REQUESTS = 1_000_000;
  const bp = billingPeriodUsage;
  const mu = monthToDateUsage;

  html += `<div ${S.section}>無料枠消費率（請求期間 30日）</div>
<table style="width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px">
${progressBar(bp.totalRequests, FREE_REQUESTS, "Workers Req", `${fmtCompact(bp.totalRequests)} / ${fmtCompact(FREE_REQUESTS)}`)}
${progressBar(bp.totalCpuTimeMs, FREE_CPU_MS, "CPU Time(推定)", `${fmtCompact(bp.totalCpuTimeMs)}ms / ${fmtCompact(FREE_CPU_MS)}ms`)}
${progressBar(mu.r2ClassAOps, FREE_R2_CLASS_A, "R2 Class A", `${fmtCompact(mu.r2ClassAOps)} / ${fmtCompact(FREE_R2_CLASS_A)}`)}
${progressBar(mu.r2ClassBOps, FREE_R2_CLASS_B, "R2 Class B", `${fmtCompact(mu.r2ClassBOps)} / ${fmtCompact(FREE_R2_CLASS_B)}`)}
${progressBar(mu.doRequests, FREE_DO_REQUESTS, "DO Req", `${fmtCompact(mu.doRequests)} / ${fmtCompact(FREE_DO_REQUESTS)}`)}
${supabaseUsage ? progressBar(supabaseUsage.dbSizeMB, supabaseUsage.dbLimitMB, "Supabase DB", `${supabaseUsage.dbSizeMB.toFixed(0)} MB / ${(supabaseUsage.dbLimitMB / 1024).toFixed(0)} GB`) : ""}
</table>`;

  // --- Workers テーブル ---
  html += `<div ${S.section}>Workers</div>
<table ${S.table}>
<tr>
  <th ${S.th}>Worker</th>
  <th ${S.thR}>Requests</th>
  <th ${S.thR}>CPU Time</th>
  <th ${S.thR}>CPU P50</th>
  <th ${S.thR}>Errors</th>
</tr>`;
  let totalCpuTimeMs = 0;
  for (const w of sorted) {
    const cpuTotalMs = w.estCpuTimeMs;
    totalCpuTimeMs += cpuTotalMs;
    const cpuTotalStr = cpuTotalMs < 1000 ? `${cpuTotalMs.toFixed(0)}ms` : `${(cpuTotalMs / 1000).toFixed(1)}s`;
    const cpuP50Ms = (w.cpuTimeP50 / 1000).toFixed(1);
    const errStyle = w.errors > 0 ? 'color:#d32f2f;font-weight:600' : 'color:#999';
    html += `<tr>
  <td ${S.td}>${w.scriptName}</td>
  <td ${S.tdR}>${fmt(w.requests)}</td>
  <td ${S.tdR}>${cpuTotalStr}</td>
  <td ${S.tdR}>${cpuP50Ms}ms</td>
  <td ${S.tdR}><span style="${errStyle}">${w.errors}</span></td>
</tr>`;
  }
  const totalCpuStr = totalCpuTimeMs < 1000 ? `${totalCpuTimeMs.toFixed(0)}ms` : `${(totalCpuTimeMs / 1000).toFixed(1)}s`;
  html += `<tr style="background:#f5f5f5;font-weight:600">
  <td ${S.td}>合計</td>
  <td ${S.tdR}>${fmt(current.workers.totalRequests)}</td>
  <td ${S.tdR}>${totalCpuStr}</td>
  <td ${S.tdR}>-</td>
  <td ${S.tdR}>${fmt(current.workers.totalErrors)}</td>
</tr>`;
  html += `</table>
<p style="margin:4px 0 0 10px;font-size:12px;color:#666">推定コスト: ${costCell(current.estimatedCosts.workers)}`;
  if (changes["Workers Requests"]) {
    const c = changes["Workers Requests"];
    html += ` | 前日比: <span style="color:${changeColor(c.changePercent)};font-weight:600">${fmtChange(c.changePercent)}</span>`;
  }
  html += `</p>`;

  // --- サービス別サマリテーブル ---
  html += `<div ${S.section}>サービス別サマリ</div>
<table ${S.table}>
<tr>
  <th ${S.th}>サービス</th>
  <th ${S.thR}>使用量</th>
  <th ${S.thR}>推定コスト</th>
</tr>
<tr>
  <td ${S.td}>Containers</td>
  <td ${S.tdR}>CPU: ${current.containers.vcpuSeconds.toFixed(1)}s / Mem: ${fmtCompact(current.containers.memoryGiBSeconds)} GiB-s / Disk: ${fmtCompact(current.containers.diskGBSeconds ?? 0)} GB-s / Egress: ${(current.containers.egressGB ?? 0).toFixed(3)} GB</td>
  <td ${S.tdR}>${costCell(current.estimatedCosts.containers)}</td>
</tr>
<tr>
  <td ${S.td}>R2</td>
  <td ${S.tdR}>${current.r2.storageGB.toFixed(2)} GB / A: ${fmt(current.r2.classAOps)} / B: ${fmt(current.r2.classBOps)}</td>
  <td ${S.tdR}>${costCell(current.estimatedCosts.r2)}</td>
</tr>
<tr>
  <td ${S.td}>Durable Objects</td>
  <td ${S.tdR}>${fmt(current.durableObjects.requests)} req / ${current.durableObjects.durationGBs.toFixed(1)} GB-s / ${current.durableObjects.storageGB.toFixed(3)} GB</td>
  <td ${S.tdR}>${costCell(current.estimatedCosts.durableObjects)}</td>
</tr>
${supabaseUsage ? `<tr>
  <td ${S.td}>Supabase (Pro)</td>
  <td ${S.tdR}>DB: ${supabaseUsage.dbSizeMB.toFixed(0)} MB / ${(supabaseUsage.dbLimitMB / 1024).toFixed(0)} GB | Compute: Micro</td>
  <td ${S.tdR}><span style="font-weight:600">$${supabaseUsage.planCost.toFixed(2)}/月</span></td>
</tr>` : ""}
</table>`;

  // --- 月間累計 ---
  html += `<div ${S.summary}>
<div style="font-weight:700;margin-bottom:6px">月間累計推定コスト</div>
<table style="width:100%;font-size:13px">
<tr>
  <td>Workers</td><td style="text-align:right;font-weight:600">${fmtCost(monthToDate.workers)}</td>
  <td style="padding-left:16px">Containers</td><td style="text-align:right;font-weight:600">${fmtCost(monthToDate.containers)}</td>
</tr>
<tr>
  <td>R2</td><td style="text-align:right;font-weight:600">${fmtCost(monthToDate.r2)}</td>
  <td style="padding-left:16px">DO</td><td style="text-align:right;font-weight:600">${fmtCost(monthToDate.durableObjects)}</td>
</tr>
<tr>
  <td>Supabase</td><td style="text-align:right;font-weight:600">${fmtCost(monthToDate.supabase)}</td>
  <td colspan="2"></td>
</tr>
<tr style="border-top:1px solid #ffe082">
  <td colspan="3" style="font-weight:700;padding-top:4px">合計</td>
  <td style="text-align:right;font-weight:700;padding-top:4px;font-size:15px">${fmtCost(monthToDate.total)}</td>
</tr>
</table>
</div>`;

  // --- 直近の請求 ---
  if (billingHistory.length > 0) {
    html += `<div ${S.section}>直近の請求</div>
<table ${S.table}>
<tr>
  <th ${S.th}>日付</th>
  <th ${S.th}>Invoice</th>
  <th ${S.thR}>金額</th>
  <th ${S.th}>状態</th>
</tr>`;
    for (const entry of billingHistory.slice(0, 3)) {
      html += `<tr>
  <td ${S.td}>${entry.occurred_at?.split("T")[0] ?? "?"}</td>
  <td ${S.td}>${entry.receipt_id}</td>
  <td ${S.tdR}>$${entry.amount}</td>
  <td ${S.td}>${entry.status}</td>
</tr>`;
    }
    html += `</table>`;
  }

  // --- アラート ---
  if (alerts.length > 0) {
    html += `<div ${S.alert}><strong>&#9888; アラート</strong><ul style="margin:6px 0 0;padding-left:20px">`;
    for (const a of alerts) {
      html += `<li>${a}</li>`;
    }
    html += `</ul></div>`;
  } else {
    html += `<div ${S.ok}>&#10003; アラート: なし</div>`;
  }

  html += `<p style="font-size:11px;color:#999;margin-top:20px">cf-billing-monitor | 毎日 06:00 JST 自動送信</p>`;
  html += `</div>`;

  return html;
}

export function buildEmail(data: EmailData): { subject: string; raw: string } {
  const subject = `[CF Billing] ${data.date} 使用量レポート${data.comparison.alerts.length > 0 ? " ⚠️" : ""}`;

  const msg = createMimeMessage();
  msg.setSender({ name: "CF Billing Monitor", addr: "billing@mtamaramu.com" });
  msg.setRecipient("m.tama.ramu@gmail.com");
  msg.setSubject(subject);
  msg.addMessage({
    contentType: "text/html",
    data: buildHtmlBody(data),
  });

  return { subject, raw: msg.asRaw() };
}
