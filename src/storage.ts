// KV 履歴保存・前日比較

export interface DailyUsage {
  date: string;
  workers: { totalRequests: number; totalErrors: number; totalCpuMs: number };
  r2: { storageGB: number; classAOps: number; classBOps: number };
  durableObjects: { requests: number; durationGBs: number; storageGB: number };
  containers: { vcpuSeconds: number; memoryGiBSeconds: number; diskGBSeconds: number; egressGB: number };
  supabase?: { dbSizeMB: number };
  estimatedCosts: {
    workers: number;
    r2: number;
    durableObjects: number;
    containers: number;
    supabase?: number;
    total: number;
  };
}

export interface Comparison {
  current: DailyUsage;
  previous: DailyUsage | null;
  changes: Record<string, { value: number; prevValue: number; changePercent: number | null }>;
  alerts: string[];
}

const TTL_30_DAYS = 30 * 24 * 60 * 60; // 2,592,000 seconds

export async function saveDaily(kv: KVNamespace, usage: DailyUsage): Promise<void> {
  await kv.put(`usage:${usage.date}`, JSON.stringify(usage), {
    expirationTtl: TTL_30_DAYS,
  });
}

export async function getPrevious(kv: KVNamespace, date: string): Promise<DailyUsage | null> {
  const prev = new Date(date + "T00:00:00Z");
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevDate = prev.toISOString().split("T")[0];
  const data = await kv.get(`usage:${prevDate}`, "text");
  return data ? (JSON.parse(data) as DailyUsage) : null;
}

function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : null;
  return ((current - previous) / previous) * 100;
}

export function compare(current: DailyUsage, previous: DailyUsage | null): Comparison {
  const alerts: string[] = [];
  const changes: Comparison["changes"] = {};

  if (previous) {
    const metrics = [
      { key: "Workers Requests", curr: current.workers.totalRequests, prev: previous.workers.totalRequests },
      { key: "Workers Errors", curr: current.workers.totalErrors, prev: previous.workers.totalErrors },
      { key: "R2 Class A Ops", curr: current.r2.classAOps, prev: previous.r2.classAOps },
      { key: "R2 Class B Ops", curr: current.r2.classBOps, prev: previous.r2.classBOps },
      { key: "DO Requests", curr: current.durableObjects.requests, prev: previous.durableObjects.requests },
      { key: "Containers vCPU", curr: current.containers.vcpuSeconds, prev: previous.containers.vcpuSeconds },
    ];

    if (current.supabase && previous.supabase) {
      metrics.push({ key: "Supabase DB Size", curr: current.supabase.dbSizeMB, prev: previous.supabase.dbSizeMB });
    }

    for (const m of metrics) {
      const pct = changePercent(m.curr, m.prev);
      changes[m.key] = { value: m.curr, prevValue: m.prev, changePercent: pct };
      if (pct !== null && pct > 200) {
        alerts.push(`${m.key}: 前日比 ${pct.toFixed(0)}% 増 (${m.prev.toLocaleString()} → ${m.curr.toLocaleString()})`);
      }
    }
  }

  // 月推定コスト $10 超のアラート
  const daysInMonth = new Date(
    new Date(current.date).getFullYear(),
    new Date(current.date).getMonth() + 1,
    0,
  ).getDate();
  const dayOfMonth = new Date(current.date).getDate();
  const projectedMonthly = (current.estimatedCosts.total / dayOfMonth) * daysInMonth;
  if (projectedMonthly > 10) {
    alerts.push(`月間推定コスト: $${projectedMonthly.toFixed(2)} (> $10 閾値超過)`);
  }

  return { current, previous, changes, alerts };
}

// 月初から今日までの累計使用量
export interface MonthToDateUsage {
  totalRequests: number;
  totalCpuMs: number;
  r2ClassAOps: number;
  r2ClassBOps: number;
  doRequests: number;
  daysCollected: number;
}

export async function getMonthToDateUsage(kv: KVNamespace, currentDate: string): Promise<MonthToDateUsage> {
  const date = new Date(currentDate + "T00:00:00Z");
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  let totalRequests = 0, totalCpuMs = 0, r2ClassAOps = 0, r2ClassBOps = 0, doRequests = 0, daysCollected = 0;

  for (let day = 1; day <= date.getUTCDate(); day++) {
    const d = new Date(Date.UTC(year, month, day));
    const key = `usage:${d.toISOString().split("T")[0]}`;
    const data = await kv.get(key, "text");
    if (data) {
      const usage = JSON.parse(data) as DailyUsage;
      totalRequests += usage.workers.totalRequests;
      totalCpuMs += usage.workers.totalCpuMs;
      r2ClassAOps += usage.r2.classAOps;
      r2ClassBOps += usage.r2.classBOps;
      doRequests += usage.durableObjects.requests;
      daysCollected++;
    }
  }

  return { totalRequests, totalCpuMs, r2ClassAOps, r2ClassBOps, doRequests, daysCollected };
}

// 月初から今日までの累計推定コスト
export async function getMonthToDateCosts(kv: KVNamespace, currentDate: string): Promise<{
  workers: number;
  r2: number;
  durableObjects: number;
  containers: number;
  supabase: number;
  total: number;
}> {
  const date = new Date(currentDate + "T00:00:00Z");
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  let workers = 0, r2 = 0, durableObjects = 0, containers = 0, supabase = 0;

  for (let day = 1; day <= date.getUTCDate(); day++) {
    const d = new Date(Date.UTC(year, month, day));
    const key = `usage:${d.toISOString().split("T")[0]}`;
    const data = await kv.get(key, "text");
    if (data) {
      const usage = JSON.parse(data) as DailyUsage;
      workers += usage.estimatedCosts.workers;
      r2 += usage.estimatedCosts.r2;
      durableObjects += usage.estimatedCosts.durableObjects;
      containers += usage.estimatedCosts.containers;
      supabase += usage.estimatedCosts.supabase ?? 0;
    }
  }

  return { workers, r2, durableObjects, containers, supabase, total: workers + r2 + durableObjects + containers + supabase };
}
