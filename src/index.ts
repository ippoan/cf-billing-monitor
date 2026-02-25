// cf-billing-monitor — Cloudflare 使用量日次レポート Worker
import { EmailMessage } from "cloudflare:email";
import { fetchWorkersMetrics, fetchR2Metrics, fetchDOMetrics, fetchContainersMetrics, fetchAccountUsageSummary } from "./graphql";
import { fetchBillingHistory } from "./billing";
import {
  calculateWorkersCost,
  calculateR2Cost,
  calculateDOCost,
  calculateContainersCost,
} from "./pricing";
import { saveDaily, getPrevious, compare, getMonthToDateCosts, getMonthToDateUsage, type DailyUsage } from "./storage";
import { buildEmail } from "./email";

export interface Env {
  CF_API_TOKEN: string;
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
  // 昨日の日付範囲 (UTC)
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];
  const startDate = `${dateStr}T00:00:00Z`;
  const endDate = `${dateStr}T23:59:59Z`;

  // 請求期間（過去30日）の開始日
  const billingStart = new Date(yesterday);
  billingStart.setUTCDate(billingStart.getUTCDate() - 29);
  const billingStartDate = `${billingStart.toISOString().split("T")[0]}T00:00:00Z`;

  console.log(`Fetching metrics for ${dateStr}`);

  // 並列でデータ取得
  const [workerMetrics, r2Metrics, doMetrics, containersMetrics, billingHistory, billingPeriodUsage] = await Promise.all([
    fetchWorkersMetrics(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchR2Metrics(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchDOMetrics(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchContainersMetrics(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchBillingHistory(env.CF_API_TOKEN, env.CF_ACCOUNT_ID),
    fetchAccountUsageSummary(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, billingStartDate, endDate),
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
    estimatedCosts: {
      workers: workersCost.estimatedCost,
      r2: r2Cost.estimatedCost,
      durableObjects: doCost.estimatedCost,
      containers: containersCost.estimatedCost,
      total: workersCost.estimatedCost + r2Cost.estimatedCost + doCost.estimatedCost + containersCost.estimatedCost,
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
  });

  console.log(`Sending email: ${subject}`);
  const emailMessage = new EmailMessage("billing@mtamaramu.com", "m.tama.ramu@gmail.com", raw);
  await env.EMAIL.send(emailMessage);
  console.log("Email sent successfully");
}
