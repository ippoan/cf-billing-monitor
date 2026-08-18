// cf-billing-monitor — Cloudflare 使用量日次レポート Worker
import { WorkerEntrypoint } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { fetchWorkersMetrics, fetchR2Metrics, fetchDOMetrics, fetchContainersMetrics, fetchQueuesMetrics, fetchAccountUsageSummary } from "./graphql";
import { fetchBillingHistory } from "./billing";
import { fetchSupabaseUsage } from "./supabase";
import {
  calculateWorkersCost,
  calculateR2Cost,
  calculateDOCost,
  calculateContainersCost,
  calculateQueuesCost,
  calculateSupabaseCost,
} from "./pricing";
import { saveDaily, getPrevious, compare, getMonthToDateCosts, getMonthToDateUsage, type DailyUsage } from "./storage";
import { buildEmail } from "./email";
import { buildFlickrEmail, buildFlickrFailureEmail, fetchFlickrStats, type FlickrCamService } from "./flickr-report";
import { buildGhCacheReportEmail, validateGhCacheReport, type GhCacheReportPayload } from "./gh-cache-report";

export interface Env {
  // CF Secrets Store bindings — plain string ではなく async `.get()` を持つ。
  CF_API_TOKEN: SecretsStoreSecret;
  SUPABASE_PAT: SecretsStoreSecret;
  // GitHub Actions cache 日次レポートの POST 認証 (Refs #16)
  GH_CACHE_REPORT_SECRET: SecretsStoreSecret;
  // 非機密の account 識別子は plain vars binding (string)。
  CF_ACCOUNT_ID: string;
  BILLING_HISTORY: KVNamespace;
  EMAIL: SendEmail;
  // Flickr 日次レポートの供給元。cf-flickr-cam-worker の named entrypoint
  // `ReportEntrypoint` への service binding (公開 URL は持たない、Refs #18)。
  FLICKR_CAM: FlickrCamService;
}

export default class CfBillingMonitor extends WorkerEntrypoint<Env> {
  async scheduled(_event: ScheduledEvent) {
    // billing / flickr は独立に送る (片方の失敗で他方を巻き込まない)
    try {
      await runReport(this.env);
    } catch (err) {
      console.error("Report failed:", err);
    }
    try {
      await runFlickrReport(this.env);
    } catch (err) {
      console.error("Flickr report failed:", err);
    }
  }

  // Flickr レポートの手動トリガーは RPC method に集約。service binding を持つ
  // Worker からのみ到達でき、外部 HTTP からは叩けない (= 旧 /trigger-flickr を秘匿)。
  async triggerFlickrReport(): Promise<void> {
    await runFlickrReport(this.env);
  }

  // 外部公開 HTTP は billing の手動トリガーと health のみ。flickr の手動トリガーは
  // RPC (triggerFlickrReport) に移したため、外部から flickr メール送信を発火できない。
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      this.ctx.waitUntil(runReport(this.env));
      return new Response("Report triggered");
    }
    // GitHub Actions cache 使用量レポート受け口 (Refs #16)。集計は送信側
    // (rust-alc-api の cache-size-report.yml) が行い、ここは検証 + メール化のみ。
    // 認証は X-Report-Secret の shared secret (fail-closed: binding 未設定なら 503)。
    if (url.pathname === "/gh-cache-report" && request.method === "POST") {
      return handleGhCacheReport(this.env, request);
    }
    return new Response("cf-billing-monitor OK");
  }
}

async function handleGhCacheReport(env: Env, request: Request): Promise<Response> {
  const secret = await env.GH_CACHE_REPORT_SECRET?.get?.().catch(() => null);
  if (!secret) {
    console.error("gh-cache-report: GH_CACHE_REPORT_SECRET binding missing/empty");
    return new Response("not configured", { status: 503 });
  }
  const given = request.headers.get("X-Report-Secret") ?? "";
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(secret);
  // timingSafeEqual は同長のみ受けるため長さ不一致は先に弾く (長さ leak は許容)
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const invalid = validateGhCacheReport(body);
  if (invalid) {
    return new Response(invalid, { status: 400 });
  }
  const payload = body as GhCacheReportPayload;
  const { subject, raw } = buildGhCacheReportEmail(payload);
  console.log(`Sending gh-cache report: ${subject}`);
  const emailMessage = new EmailMessage(
    "gh-cache-report@mtamaramu.com",
    "m.tama.ramu@gmail.com",
    raw,
  );
  await env.EMAIL.send(emailMessage);
  return new Response("sent");
}

async function runFlickrReport(env: Env): Promise<void> {
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dateStr = nowJst.toISOString().split("T")[0];

  // 集計の取得に失敗しても「無音で止まる」を避ける — 失敗を件名に出した 1 通を
  // 必ず送る (2026-07-08 の供給元廃止に 6 週間気付けなかった、Refs #18)。
  let mail: { subject: string; raw: string };
  try {
    mail = buildFlickrEmail(await fetchFlickrStats(env), dateStr);
  } catch (err) {
    console.error("Flickr stats fetch failed:", err);
    mail = buildFlickrFailureEmail(dateStr, err);
  }

  console.log(`Sending flickr report: ${mail.subject}`);
  const emailMessage = new EmailMessage(
    "flickr-report@mtamaramu.com",
    "m.tama.ramu@gmail.com",
    mail.raw,
  );
  await env.EMAIL.send(emailMessage);
  console.log("Flickr report sent successfully");
}

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
  const [workerMetrics, r2Metrics, doMetrics, containersMetrics, queuesMetrics, billingHistory, billingPeriodUsage, supabaseUsage] = await Promise.all([
    fetchWorkersMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDateTime, endDateTime),
    fetchR2Metrics(cfApiToken, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchDOMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDateTime, endDateTime),
    fetchContainersMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDate, endDate),
    fetchQueuesMetrics(cfApiToken, env.CF_ACCOUNT_ID, startDate, endDate),
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
  const queuesCost = calculateQueuesCost(queuesMetrics.operations);

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
    queues: queuesMetrics,
    supabase: supabaseUsage ? { dbSizeMB: supabaseUsage.dbSizeMB } : undefined,
    estimatedCosts: {
      workers: workersCost.estimatedCost,
      r2: r2Cost.estimatedCost,
      durableObjects: doCost.estimatedCost,
      containers: containersCost.estimatedCost,
      queues: queuesCost.estimatedCost,
      supabase: supabaseDailyCost,
      total: workersCost.estimatedCost + r2Cost.estimatedCost + doCost.estimatedCost + containersCost.estimatedCost + queuesCost.estimatedCost + supabaseDailyCost,
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
