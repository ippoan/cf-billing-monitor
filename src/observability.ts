// Cloudflare Observability (Workers Logs / Traces 等) の取り込み量・保存量
//
// 2026-12-01 から Observability は GB 課金 (取り込み GB + 保存 GB-month) に移行する。
// Paid の無料枠は請求期間ごとに 取り込み 50 GB / 保存 10 GB-month。
// https://developers.cloudflare.com/observability/pricing/
//
// 取得元は Billable Usage API (alpha)。日次 × 課金メトリクス単位のレコードが返り、
// 無料枠内の使用量も含まれる。Observability の行は ServiceName / ChargeDescription
// の文字列で拾う (alpha のため名前が確定しておらず、移行前は行が無い可能性もある)。
// 取れなかった場合も throw せず found=false / error を返し、メール側で注記する。

export const OBS_FREE_INGEST_GB = 50;
export const OBS_FREE_STORAGE_GB_MONTH = 10;
/** 1 日の取り込みがこれを超えたらアラート (50 GB / 30 日 ≈ 1.67 GB/日 の手前) */
export const OBS_DAILY_INGEST_ALERT_GB = 1;

export interface ObservabilityUsage {
  /** Observability の行が 1 件以上見つかったか */
  found: boolean;
  /** 請求期間の累計取り込み (GB) */
  ingestedGB: number;
  /** 請求期間の累計保存 (GB-month) */
  storedGBMonth: number;
  /** 取り込みのある最新日 (YYYY-MM-DD) とその日の取り込み (GB) */
  lastDay: string | null;
  lastDayIngestedGB: number;
  /** 請求期間の累計コスト (USD、無料枠内なら 0) */
  cost: number;
  /** 拾った行の ServiceName (確認用) */
  services: string[];
  /** API 呼び出し自体の失敗 */
  error?: string;
  /** 判定調整用: API の全行を (ServiceName, 説明, 単位) で束ねた一覧 */
  debugRows: DebugRow[];
}

export interface DebugRow {
  service: string;
  description: string;
  unit: string;
  /** 振り分け結果: ingest / storage / 対象外 */
  kind: "ingest" | "storage" | "-";
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
const OBS_PATTERN = /observability|workers logs|workers traces|cloudflare traces|\btraces?\b/i;

function empty(error?: string): ObservabilityUsage {
  return {
    found: false,
    ingestedGB: 0,
    storedGBMonth: 0,
    lastDay: null,
    lastDayIngestedGB: 0,
    cost: 0,
    services: [],
    debugRows: [],
    ...(error ? { error } : {}),
  };
}

/** ConsumedUnit を見て GB に揃える (bytes / MB / GB を想定、不明はそのまま) */
function toGB(quantity: number, unit: string): number {
  const u = unit.toLowerCase();
  if (/^bytes?\b/.test(u)) return quantity / 1e9;
  if (/^kb\b/.test(u)) return quantity / 1e6;
  if (/^mb\b/.test(u)) return quantity / 1e3;
  if (/^tb\b/.test(u)) return quantity * 1e3;
  return quantity;
}

export function summarizeObservability(records: UsageRecord[]): ObservabilityUsage {
  const result = empty();
  const services = new Set<string>();
  const ingestByDay = new Map<string, number>();
  const debug = new Map<string, DebugRow & { daySet: Set<string> }>();

  for (const r of records) {
    const label = `${r.ServiceFamilyName ?? ""} ${r.ServiceName ?? ""} ${r.ChargeDescription ?? ""}`;
    const matched = OBS_PATTERN.test(label);
    const unitRaw = r.ConsumedUnit ?? "";
    const isStorage = /month/i.test(unitRaw) || /storage|stored/i.test(label);
    const kind: DebugRow["kind"] = !matched ? "-" : isStorage ? "storage" : "ingest";
    const dayKey = r.ChargePeriodStart?.split("T")[0] ?? "";
    const dkey = `${r.ServiceName ?? ""}|${r.ChargeDescription ?? ""}|${unitRaw}`;
    const d = debug.get(dkey) ?? {
      service: r.ServiceName ?? "",
      description: r.ChargeDescription ?? "",
      unit: unitRaw,
      kind,
      quantity: 0,
      days: 0,
      firstDay: dayKey,
      lastDay: dayKey,
      daySet: new Set<string>(),
    };
    d.quantity += r.ConsumedQuantity ?? 0;
    if (dayKey) {
      d.daySet.add(dayKey);
      if (!d.firstDay || dayKey < d.firstDay) d.firstDay = dayKey;
      if (dayKey > d.lastDay) d.lastDay = dayKey;
    }
    debug.set(dkey, d);
    if (!matched) continue;

    result.found = true;
    if (r.ServiceName) services.add(r.ServiceName);
    result.cost += r.ContractedCost ?? 0;

    const qty = toGB(r.ConsumedQuantity ?? 0, unitRaw);
    // 保存は GB-month、取り込みは GB。単位か説明文で見分ける。
    if (isStorage) {
      result.storedGBMonth += qty;
    } else {
      result.ingestedGB += qty;
      const day = r.ChargePeriodStart?.split("T")[0];
      if (day) ingestByDay.set(day, (ingestByDay.get(day) ?? 0) + qty);
    }
  }

  const days = [...ingestByDay.keys()].sort();
  const last = days[days.length - 1];
  if (last) {
    result.lastDay = last;
    result.lastDayIngestedGB = ingestByDay.get(last) ?? 0;
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
  if (!u.found) return alerts;
  if (u.lastDayIngestedGB > OBS_DAILY_INGEST_ALERT_GB) {
    alerts.push(
      `Observability: ${u.lastDay} の取り込みが ${u.lastDayIngestedGB.toFixed(2)} GB (目安 ${OBS_DAILY_INGEST_ALERT_GB} GB/日 超)`,
    );
  }
  if (u.ingestedGB > OBS_FREE_INGEST_GB * 0.8) {
    alerts.push(`Observability: 取り込み累計 ${u.ingestedGB.toFixed(1)} GB が無料枠 ${OBS_FREE_INGEST_GB} GB の 80% 超`);
  }
  if (u.storedGBMonth > OBS_FREE_STORAGE_GB_MONTH * 0.8) {
    alerts.push(
      `Observability: 保存累計 ${u.storedGBMonth.toFixed(2)} GB-month が無料枠 ${OBS_FREE_STORAGE_GB_MONTH} GB-month の 80% 超`,
    );
  }
  return alerts;
}
