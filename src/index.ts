// cf-billing-monitor — Cloudflare 使用量日次レポート Worker
import { EmailMessage } from "cloudflare:email";
import { fetchWorkersMetrics, fetchR2Metrics, fetchDOMetrics, fetchContainersMetrics, fetchAccountUsageSummary } from "./graphql";
import { fetchBillingHistory } from "./billing";
import { fetchSupabaseUsage } from "./supabase";
import {
  calculateWorkersCost,
  calculateR2Cost,
  calculateDOCost,
  calculateContainersCost,
  calculateSupabaseCost,
} from "./pricing";
import { saveDaily, getPrevious, compare, getMonthToDateCosts, getMonthToDateUsage, type DailyUsage } from "./storage";
import { buildEmail } from "./email";

export interface Env {
  // CF Secrets Store bindings — plain string ではなく async `.get()` を持つ。
  CF_API_TOKEN: SecretsStoreSecret;
  SUPABASE_PAT: SecretsStoreSecret;
  // 非機密の account 識別子は plain vars binding (string)。
  CF_ACCOUNT_ID: string;
  BILLING_HISTORY: KVNamespace;
  EMAIL: SendEmail;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      await runReport(env);
    } catch (err) {
      console.error("Report failed:", err);
    }
  },

  // fetch handler for manual trigger / health check
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      ctx.waitUntil(runReport(env));
      return new Response("Report triggered");
    }
    return new Response("cf-billing-monitor OK");
  },
};

async function runReport(env: Env): Promise<void> {
  const now = new Date();
  const JST = 9 * 60 * 60 * 1000;
  const nowJst = new Date(now.getTime() + JST);
  const jstTodayMidUTC = Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate()) - JST;
  const startMs = jstTodayMidUTC - 24 * 60 * 60 * 1000; // JST昨日 0:00
  const endMs = jstTodayMidUTC - 1000;                  // JST昨日 23:59:59
  const dateStr = new Date(startMs + JST).toISOString().split("T")[0];            // 件名/表示 = JST昨日
  const startDateTime = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z"); // datetime系用
  const endDateTime = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const startDate = `${dateStr}T00:00:00Z`; // date系用(内部でsplitされJST昨日になる)
  const endDate = `${dateStr}T23:59:59Z`;
  const billingStartDate = new Date(startMs - 29 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  console.log(`Fetching metrics for ${dateStr}`);

  // CF Secrets Store binding は plain string ではないので async .get() で取り出す。
  const cfApiToken = await env.CF_API_TOKEN.get();
  const supabasePat = await env.SUPABASE_PAT.get();

  // 並列でデータ取得
  const [workerMetrics, r2Metrics, doMetrics, containersMetrics, billingHistory, billingPeriodUsage, supabaseUsage] = await Promise.all([
    fetchWorkersMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDateTime, endDateTime),
    fetchR2Metrics(cfApiToken, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchDOMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDateTime, endDateTime),
    fetchContainersMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchBillingHistory(cfApiToken, env.CF_ACCOUNT_ID),
    fetchAccountUsageSummary(cfApiToken, env.CF_ACCOUNT_ID, billingStartDate, endDateTime),
    fetchSupabaseUsage(supabasePat),
  ]);

  // Workers 集計
  let totalRequests = 0;
  let totalErrors = 0;
  let totalCpuMs = 0;
  for (const w of workerMetrics) {
    totalRequests += w.requests;
    totalErrors += w.errors;
    // estCpuTimeMs は推定合計 CPU 時間（P50 * requests、ミリ秒）
    totalCpuMs += w.estCpuTimeMs;
  }

  // コスト計算
  const workersCost = calculateWorkersCost(totalRequests, totalCpuMs);
  const r2Cost = calculateR2Cost(
    r2Metrics.storageBytes / (1024 * 1024 * 1024),
    r2Metrics.classAOps,
    r2Metrics.classBOps,
  );
  const doCost = calculateDOCost(
    doMetrics.requests,
    (doMetrics.wallTimeMs / 1000) * 0.000128, // 概算: 128MB DO → GB-seconds
    doMetrics.storageBytes / (1024 * 1024 * 1024),
  );
  const containersCost = calculateContainersCost(
    containersMetrics.cpuSeconds,
    containersMetrics.memoryGiBSeconds,
    containersMetrics.diskGBSeconds,
    containersMetrics.egressGB,
  );

  // Supabase コスト（月額固定を日割り）
  const supabaseCost = supabaseUsage
    ? calculateSupabaseCost(supabaseUsage.dbSizeMB / 1024, supabaseUsage.computeCost)
    : null;
  const [dy, dm] = dateStr.split("-").map(Number);
  const daysInMonth = new Date(dy, dm, 0).getDate();
  const supabaseDailyCost = supabaseCost ? supabaseCost.estimatedCost / daysInMonth : 0;

  const dailyUsage: DailyUsage = {
    date: dateStr,
    workers: { totalRequests, totalErrors, totalCpuMs },
    r2: {
      storageGB: r2Metrics.storageBytes / (1024 * 1024 * 1024),
      classAOps: r2Metrics.classAOps,
      classBOps: r2Metrics.classBOps,
    },
    durableObjects: {
      requests: doMetrics.requests,
      durationGBs: (doMetrics.wallTimeMs / 1000) * 0.000128,
      storageGB: doMetrics.storageBytes / (1024 * 1024 * 1024),
    },
    containers: {
      vcpuSeconds: containersMetrics.cpuSeconds,
      memoryGiBSeconds: containersMetrics.memoryGiBSeconds,
      diskGBSeconds: containersMetrics.diskGBSeconds,
      egressGB: containersMetrics.egressGB,
    },
    supabase: supabaseUsage ? { dbSizeMB: supabaseUsage.dbSizeMB } : undefined,
    estimatedCosts: {
      workers: workersCost.estimatedCost,
      r2: r2Cost.estimatedCost,
      durableObjects: doCost.estimatedCost,
      containers: containersCost.estimatedCost,
      supabase: supabaseDailyCost,
      total: workersCost.estimatedCost + r2Cost.estimatedCost + doCost.estimatedCost + containersCost.estimatedCost + supabaseDailyCost,
    },
  };

  // KV 保存 & 前日比較
  const previous = await getPrevious(env.BILLING_HISTORY, dateStr);
  await saveDaily(env.BILLING_HISTORY, dailyUsage);
  const comparison = compare(dailyUsage, previous);

  // 月初から今日までの累計
  const [monthToDate, monthToDateUsage] = await Promise.all([
    getMonthToDateCosts(env.BILLING_HISTORY, dateStr),
    getMonthToDateUsage(env.BILLING_HISTORY, dateStr),
  ]);

  // メール送信
  const { subject, raw } = buildEmail({
    date: dateStr,
    workerMetrics,
    comparison,
    monthToDate,
    monthToDateUsage,
    billingPeriodUsage,
    billingHistory,
    supabaseUsage,
  });

  console.log(`Sending email: ${subject}`);
  const emailMessage = new EmailMessage("billing@mtamaramu.com", "m.tama.ramu@gmail.com", raw);
  await env.EMAIL.send(emailMessage);
  console.log("Email sent successfully");
}
