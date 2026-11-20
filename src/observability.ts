// Cloudflare Observability (Workers Logs / Traces 等) の取り込み量・保存量
//
// 2026-12-01 から Observability は GB 課金 (取り込み GB + 保存 GB-month) に移行する。
// Paid の無料枠は請求期間ごとに 取り込み 50 GB / 保存 10 GB-month。
// https://developers.cloudflare.com/observability/pricing/
//
// 取得元は Billable Usage API (alpha)。日次 × 課金メトリクス単位のレコードが返る。
// 2026-11 時点で返る Observability の行は旧課金 (イベント数) の
//   "Observability - Logs (First 20M included)" / 単位 "Millions of requests"
// の 1 本だけで、GB・GB-month の行はまだ無い。そのため
//   - GB の行があればそれを使う (12/1 以降を想定)
//   - 無ければイベント数 × 平均イベントサイズで GB を推定し、推定と明示する
// 取れなかった場合も throw せず found=false / error を返し、メール側で注記する。

export const OBS_FREE_INGEST_GB = 50;
export const OBS_FREE_STORAGE_GB_MONTH = 10;
/** 旧課金 (イベント数) の無料枠: 2,000 万イベント / 月 */
export const OBS_FREE_EVENTS_MILLIONS = 20;
/**
 * GB 推定に使う平均イベントサイズ (KB)。ダッシュボード Observability > Usage の
 * "Avg event size" (2026-11-20 時点 2.3 KB) に合わせる。
 */
export const OBS_EST_EVENT_KB = 2.3;
/** 1 日の取り込みがこれを超えたらアラート (50 GB / 30 日 ≈ 1.67 GB/日 の手前) */
export const OBS_DAILY_INGEST_ALERT_GB = 1;

export interface ObservabilityUsage {
  /** Observability の行が 1 件以上見つかったか */
  found: boolean;
  /** GB の値の出どころ: GB 課金の行 / イベント数からの推定 */
  source: "gb" | "events" | null;
  /** 請求期間の累計取り込み (GB)。source=events なら推定値 */
  ingestedGB: number;
  /** 請求期間の累計保存 (GB-month)。GB 課金の行が無い間は 0 */
  storedGBMonth: number;
  /** 取り込みのある最新日 (YYYY-MM-DD) とその日の取り込み (GB、source=events なら推定) */
  lastDay: string | null;
  lastDayIngestedGB: number;
  /** 旧課金のイベント数 (百万件)。請求期間累計と最新日 */
  eventsMillions: number;
  lastDayEventsMillions: number;
  /** 請求期間の累計コスト (USD、無料枠内なら 0) */
  cost: number;
  /** 拾った行の ServiceName (確認用) */
  services: string[];
  /** API 呼び出し自体の失敗 */
  error?: string;
  /** 判定確認用: Observability らしい行を (ServiceName, 説明, 単位) で束ねた一覧 */
  debugRows: DebugRow[];
}

export interface DebugRow {
  service: string;
  description: string;
  unit: string;
  /** 振り分け結果 */
  kind: "ingest" | "storage" | "events" | "-";
  /** ConsumedQuantity の合計 (単位換算前) */
  quantity: number;
  days: number;
  firstDay: string;
  lastDay: string;
}

interface UsageRecord {
  ServiceName?: string;
  ServiceFamilyName?: string | null;
  ChargeDescription?: string;
  ChargePeriodStart?: string;
  ConsumedQuantity?: number;
  ConsumedUnit?: string;
  ContractedCost?: number;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
/** 集計対象 */
const OBS_PATTERN = /observability|workers logs|workers traces|cloudflare traces|\btraces?\b/i;
/** 判定確認用に一覧へ出す範囲 (対象外でも名前が近いものは出す) */
const DEBUG_PATTERN = /observ|\blogs?\b|trac/i;

function empty(error?: string): ObservabilityUsage {
  return {
    found: false,
    source: null,
    ingestedGB: 0,
    storedGBMonth: 0,
    lastDay: null,
    lastDayIngestedGB: 0,
    eventsMillions: 0,
    lastDayEventsMillions: 0,
    cost: 0,
    services: [],
    debugRows: [],
    ...(error ? { error } : {}),
  };
}

/** ConsumedUnit を見て GB に揃える (bytes / KB / MB / GB / TB を想定、不明はそのまま) */
function toGB(quantity: number, unit: string): number {
  const u = unit.toLowerCase();
  if (/^bytes?\b/.test(u)) return quantity / 1e9;
  if (/^kb\b/.test(u)) return quantity / 1e6;
  if (/^mb\b/.test(u)) return quantity / 1e3;
  if (/^tb\b/.test(u)) return quantity * 1e3;
  return quantity;
}

/** イベント数系の単位を百万件に揃える ("Millions of requests" / "Count" など) */
function toMillions(quantity: number, unit: string): number {
  return /million/i.test(unit) ? quantity : quantity / 1e6;
}

function classify(unit: string, label: string): Exclude<DebugRow["kind"], "-"> {
  if (/request|event|count/i.test(unit)) return "events";
  if (/month/i.test(unit) || /storage|stored/i.test(label)) return "storage";
  return "ingest";
}

function eventsToGB(millions: number): number {
  return (millions * 1e6 * OBS_EST_EVENT_KB * 1e3) / 1e9;
}

export function summarizeObservability(records: UsageRecord[]): ObservabilityUsage {
  const result = empty();
  const services = new Set<string>();
  const gbByDay = new Map<string, number>();
  const eventsByDay = new Map<string, number>();
  const debug = new Map<string, DebugRow & { daySet: Set<string> }>();

  for (const r of records) {
    const label = `${r.ServiceFamilyName ?? ""} ${r.ServiceName ?? ""} ${r.ChargeDescription ?? ""}`;
    const unit = r.ConsumedUnit ?? "";
    const matched = OBS_PATTERN.test(label);
    const kind: DebugRow["kind"] = matched ? classify(unit, label) : "-";
    const day = r.ChargePeriodStart?.split("T")[0] ?? "";
    const raw = r.ConsumedQuantity ?? 0;

    if (matched || DEBUG_PATTERN.test(label)) {
      const key = `${r.ServiceName ?? ""}|${r.ChargeDescription ?? ""}|${unit}`;
      const d = debug.get(key) ?? {
        service: r.ServiceName ?? "",
        description: r.ChargeDescription ?? "",
        unit,
        kind,
        quantity: 0,
        days: 0,
        firstDay: day,
        lastDay: day,
        daySet: new Set<string>(),
      };
      d.quantity += raw;
      if (day) {
        d.daySet.add(day);
        if (!d.firstDay || day < d.firstDay) d.firstDay = day;
        if (day > d.lastDay) d.lastDay = day;
      }
      debug.set(key, d);
    }
    if (!matched) continue;

    result.found = true;
    if (r.ServiceName) services.add(r.ServiceName);
    result.cost += r.ContractedCost ?? 0;

    if (kind === "events") {
      const m = toMillions(raw, unit);
      result.eventsMillions += m;
      if (day) eventsByDay.set(day, (eventsByDay.get(day) ?? 0) + m);
    } else if (kind === "storage") {
      result.storedGBMonth += toGB(raw, unit);
    } else {
      const gb = toGB(raw, unit);
      result.ingestedGB += gb;
      if (day) gbByDay.set(day, (gbByDay.get(day) ?? 0) + gb);
    }
  }

  const latest = (m: Map<string, number>) => [...m.keys()].sort().pop();

  const lastEventsDay = latest(eventsByDay);
  if (lastEventsDay) result.lastDayEventsMillions = eventsByDay.get(lastEventsDay) ?? 0;

  const lastGbDay = latest(gbByDay);
  if (lastGbDay) {
    result.source = "gb";
    result.lastDay = lastGbDay;
    result.lastDayIngestedGB = gbByDay.get(lastGbDay) ?? 0;
  } else if (lastEventsDay) {
    // GB 課金の行がまだ無い → イベント数から推定
    result.source = "events";
    result.ingestedGB = eventsToGB(result.eventsMillions);
    result.lastDay = lastEventsDay;
    result.lastDayIngestedGB = eventsToGB(result.lastDayEventsMillions);
  }

  result.services = [...services].sort();
  result.debugRows = [...debug.values()]
    .map(({ daySet, ...row }) => ({ ...row, days: daySet.size }))
    .sort((a, b) => (a.kind === "-" ? 1 : 0) - (b.kind === "-" ? 1 : 0) || a.service.localeCompare(b.service));
  return result;
}

export async function fetchObservabilityUsage(token: string, accountId: string): Promise<ObservabilityUsage> {
  try {
    // クエリなし = 現在の請求期間
    const resp = await fetch(`${API_BASE}/accounts/${accountId}/billable-usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 200);
      console.error(`Billable Usage API error: ${resp.status} ${text}`);
      return empty(`Billable Usage API ${resp.status}`);
    }
    const data = (await resp.json()) as { success?: boolean; result?: UsageRecord[] };
    return summarizeObservability(data.result ?? []);
  } catch (err) {
    console.error("Observability usage fetch failed:", err);
    return empty(err instanceof Error ? err.message : String(err));
  }
}

/** メールのアラート欄に足す文言 */
export function observabilityAlerts(u: ObservabilityUsage): string[] {
  const alerts: string[] = [];
  if (!u.found || !u.source) return alerts;
  const est = u.source === "events" ? "（推定）" : "";
  if (u.lastDayIngestedGB > OBS_DAILY_INGEST_ALERT_GB) {
    alerts.push(
      `Observability: ${u.lastDay} の取り込みが ${u.lastDayIngestedGB.toFixed(2)} GB${est} (目安 ${OBS_DAILY_INGEST_ALERT_GB} GB/日 超)`,
    );
  }
  if (u.ingestedGB > OBS_FREE_INGEST_GB * 0.8) {
    alerts.push(`Observability: 取り込み累計 ${u.ingestedGB.toFixed(1)} GB${est} が無料枠 ${OBS_FREE_INGEST_GB} GB の 80% 超`);
  }
  if (u.storedGBMonth > OBS_FREE_STORAGE_GB_MONTH * 0.8) {
    alerts.push(
      `Observability: 保存累計 ${u.storedGBMonth.toFixed(2)} GB-month が無料枠 ${OBS_FREE_STORAGE_GB_MONTH} GB-month の 80% 超`,
    );
  }
  return alerts;
}

// --- v2 (/billable/usage, Alpha, Restricted) の確認用プローブ (一時) ---
// v1 に Observability の GB / GB-month 行が無いため、v2 で取れるかを見る。
// 結果はメールの確認用一覧に出すだけで、集計値には使わない。

export interface V2Probe {
  /** HTTP ステータス、または通信失敗時のメッセージ */
  status: number | string;
  /** 全行数 */
  totalRows: number;
  /** Observability 関連の行 (v1 と同じ束ね方) */
  debugRows: DebugRow[];
  /** エラー本文の先頭 (権限エラーなどの確認用) */
  errorBody?: string;
}

interface V2Record {
  ChargeDescription?: string;
  ChargePeriodStart?: string;
  ConsumedQuantity?: number;
  ConsumedUnit?: string;
  ContractedCost?: number;
  x_BillableMetricName?: string;
  x_ProductCategoryName?: string;
  x_ProductFamilyName?: string;
}

export async function probeBillableUsageV2(token: string, accountId: string): Promise<V2Probe> {
  try {
    const resp = await fetch(`${API_BASE}/accounts/${accountId}/billable/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 300);
      console.error(`Billable Usage API v2 error: ${resp.status} ${body}`);
      return { status: resp.status, totalRows: 0, debugRows: [], errorBody: body };
    }
    const data = (await resp.json()) as { result?: V2Record[] };
    const records = data.result ?? [];
    // v1 の形に寄せて同じ判定・束ね方を使う (ServiceName は v2 に無いので metric 名で代用)
    const mapped: UsageRecord[] = records.map((r) => ({
      ServiceName: r.x_BillableMetricName ?? r.x_ProductFamilyName ?? "",
      ServiceFamilyName: [r.x_ProductFamilyName, r.x_ProductCategoryName].filter(Boolean).join(" "),
      ChargeDescription: r.ChargeDescription,
      ChargePeriodStart: r.ChargePeriodStart,
      ConsumedQuantity: r.ConsumedQuantity,
      ConsumedUnit: r.ConsumedUnit,
      ContractedCost: r.ContractedCost,
    }));
    return { status: resp.status, totalRows: records.length, debugRows: summarizeObservability(mapped).debugRows };
  } catch (err) {
    console.error("Billable Usage API v2 probe failed:", err);
    return { status: err instanceof Error ? err.message : String(err), totalRows: 0, debugRows: [] };
  }
}
