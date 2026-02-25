// Cloudflare GraphQL Analytics API クエリ

export interface WorkerMetrics {
  scriptName: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeP50: number;     // P50 (マイクロ秒)
  cpuTimeP75: number;     // P75 (マイクロ秒)
  cpuTimeP99: number;     // P99 (マイクロ秒)
  estCpuTimeMs: number;   // 推定合計 CPU 時間 (ミリ秒) — パーセンタイル加重平均
}

// 請求期間の使用量サマリ（ダッシュボードと同じ値）
export interface AccountUsageSummary {
  totalRequests: number;
  totalCpuTimeMs: number;  // ミリ秒（sum of estCpuTimeMs across all workers）
}

export async function fetchAccountUsageSummary(
  token: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<AccountUsageSummary> {
  // ダッシュボードと同じ: 請求期間全体の合計を取得
  const metrics = await fetchWorkersMetrics(token, accountId, startDate, endDate);
  let totalRequests = 0;
  let totalCpuTimeMs = 0;
  for (const m of metrics) {
    totalRequests += m.requests;
    totalCpuTimeMs += m.estCpuTimeMs;
  }
  return { totalRequests, totalCpuTimeMs };
}

export interface R2Metrics {
  classAOps: number;
  classBOps: number;
  storageBytes: number;
}

export interface DOMetrics {
  requests: number;
  wallTimeMs: number;
  storageBytes: number;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

async function queryGraphQL(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`GraphQL API error: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

export async function fetchWorkersMetrics(
  token: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<WorkerMetrics[]> {
  const query = `
    query WorkersMetrics($accountTag: string!, $startDate: Time!, $endDate: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 100
            filter: {
              datetime_geq: $startDate
              datetime_leq: $endDate
            }
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP25
              cpuTimeP50
              cpuTimeP75
              cpuTimeP90
              cpuTimeP99
            }
            dimensions {
              scriptName
            }
          }
        }
      }
    }
  `;

  const data = (await queryGraphQL(token, query, {
    accountTag: accountId,
    startDate,
    endDate,
  })) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          workersInvocationsAdaptive?: Array<{
            sum: { requests: number; errors: number; subrequests: number };
            quantiles: { cpuTimeP25: number; cpuTimeP50: number; cpuTimeP75: number; cpuTimeP90: number; cpuTimeP99: number };
            dimensions: { scriptName: string };
          }>;
        }>;
      };
    };
  };

  const invocations = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return invocations.map((inv) => {
    const q = inv.quantiles;
    // GraphQL API は sum.cpuTime を提供しない（quantiles のみ）
    // パーセンタイル加重平均で推定（ダッシュボードの値とは多少ズレる）
    const estAvgUs =
      q.cpuTimeP25 * 0.25 +
      ((q.cpuTimeP25 + q.cpuTimeP50) / 2) * 0.25 +
      ((q.cpuTimeP50 + q.cpuTimeP75) / 2) * 0.25 +
      ((q.cpuTimeP75 + q.cpuTimeP90) / 2) * 0.15 +
      ((q.cpuTimeP90 + q.cpuTimeP99) / 2) * 0.09 +
      q.cpuTimeP99 * 0.01;
    const cpuTimeMs = (estAvgUs * inv.sum.requests) / 1000;
    return {
      scriptName: inv.dimensions.scriptName,
      requests: inv.sum.requests,
      errors: inv.sum.errors,
      subrequests: inv.sum.subrequests,
      cpuTimeP50: q.cpuTimeP50,
      cpuTimeP75: q.cpuTimeP75,
      cpuTimeP99: q.cpuTimeP99,
      estCpuTimeMs: cpuTimeMs,
    };
  });
}

export async function fetchR2Metrics(
  token: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<R2Metrics> {
  const opsQuery = `
    query R2Operations($accountTag: string!, $startDate: Date!, $endDate: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            limit: 10
            filter: {
              date_geq: $startDate
              date_leq: $endDate
            }
          ) {
            sum {
              requests
            }
            dimensions {
              actionType
            }
          }
          r2StorageAdaptiveGroups(
            limit: 1
            filter: {
              date_geq: $startDate
              date_leq: $endDate
            }
          ) {
            max {
              payloadSize
            }
          }
        }
      }
    }
  `;

  const dateStart = startDate.split("T")[0];
  const dateEnd = endDate.split("T")[0];

  const data = (await queryGraphQL(token, opsQuery, {
    accountTag: accountId,
    startDate: dateStart,
    endDate: dateEnd,
  })) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          r2OperationsAdaptiveGroups?: Array<{
            sum: { requests: number };
            dimensions: { actionType: string };
          }>;
          r2StorageAdaptiveGroups?: Array<{
            max: { payloadSize: number };
          }>;
        }>;
      };
    };
  };

  const account = data?.data?.viewer?.accounts?.[0];
  const ops = account?.r2OperationsAdaptiveGroups ?? [];
  const storage = account?.r2StorageAdaptiveGroups ?? [];

  // Class A: PutObject, PostObject, CopyObject, ListBucket, ListObject
  // Class B: GetObject, HeadObject
  const classAActions = new Set(["PutObject", "PostObject", "CopyObject", "ListBucket", "ListObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload"]);
  let classAOps = 0;
  let classBOps = 0;
  for (const op of ops) {
    if (classAActions.has(op.dimensions.actionType)) {
      classAOps += op.sum.requests;
    } else {
      classBOps += op.sum.requests;
    }
  }

  return {
    classAOps,
    classBOps,
    storageBytes: storage[0]?.max?.payloadSize ?? 0,
  };
}

export interface ContainersMetrics {
  cpuSeconds: number;
  memoryGiBSeconds: number;
  diskGBSeconds: number;
  egressGB: number;
}

export async function fetchContainersMetrics(
  token: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<ContainersMetrics> {
  // active 別に集計: active=1（稼働中）のみが課金対象
  const query = `
    query ContainersMetrics($accountTag: string!, $startDate: Date!, $endDate: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          containersMetricsAdaptiveGroups(
            limit: 10
            filter: {
              date_geq: $startDate
              date_leq: $endDate
            }
          ) {
            sum {
              cpuTimeSec
              allocatedMemory
              allocatedDisk
              txBytes
            }
            dimensions {
              active
            }
          }
        }
      }
    }
  `;

  const dateStart = startDate.split("T")[0];
  const dateEnd = endDate.split("T")[0];

  const data = (await queryGraphQL(token, query, {
    accountTag: accountId,
    startDate: dateStart,
    endDate: dateEnd,
  })) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          containersMetricsAdaptiveGroups?: Array<{
            sum: { cpuTimeSec: number; allocatedMemory: number; allocatedDisk: number; txBytes: number };
            dimensions: { active: number };
          }>;
        }>;
      };
    };
  };

  const groups = data?.data?.viewer?.accounts?.[0]?.containersMetricsAdaptiveGroups ?? [];

  // active=1 のデータのみ使用（課金対象）、なければ 0
  const activeGroup = groups.find((g) => g.dimensions.active === 1);
  if (!activeGroup) {
    return { cpuSeconds: 0, memoryGiBSeconds: 0, diskGBSeconds: 0, egressGB: 0 };
  }

  const s = activeGroup.sum;
  return {
    cpuSeconds: s.cpuTimeSec,
    memoryGiBSeconds: s.allocatedMemory / (1024 ** 3),  // byte-seconds → GiB-seconds
    diskGBSeconds: s.allocatedDisk / (10 ** 9),          // byte-seconds → GB-seconds
    egressGB: s.txBytes / (10 ** 9),                     // bytes → GB
  };
}

export async function fetchDOMetrics(
  token: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<DOMetrics> {
  const query = `
    query DOMetrics($accountTag: string!, $startDate: Time!, $endDate: Time!, $dateStart: Date!, $dateEnd: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsInvocationsAdaptiveGroups(
            limit: 100
            filter: {
              datetime_geq: $startDate
              datetime_leq: $endDate
            }
          ) {
            sum {
              requests
              wallTime
            }
          }
          durableObjectsStorageGroups(
            limit: 1
            filter: {
              date_geq: $dateStart
              date_leq: $dateEnd
            }
          ) {
            max {
              storedBytes
            }
          }
        }
      }
    }
  `;

  const dateStart = startDate.split("T")[0];
  const dateEnd = endDate.split("T")[0];

  const data = (await queryGraphQL(token, query, {
    accountTag: accountId,
    startDate,
    endDate,
    dateStart,
    dateEnd,
  })) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          durableObjectsInvocationsAdaptiveGroups?: Array<{
            sum: { requests: number; wallTime: number };
          }>;
          durableObjectsStorageGroups?: Array<{
            max: { storedBytes: number };
          }>;
        }>;
      };
    };
  };

  const account = data?.data?.viewer?.accounts?.[0];
  const invocations = account?.durableObjectsInvocationsAdaptiveGroups ?? [];
  const storage = account?.durableObjectsStorageGroups ?? [];

  let totalRequests = 0;
  let totalWallTimeMs = 0;
  for (const inv of invocations) {
    totalRequests += inv.sum.requests;
    totalWallTimeMs += inv.sum.wallTime;
  }

  return {
    requests: totalRequests,
    wallTimeMs: totalWallTimeMs,
    storageBytes: storage[0]?.max?.storedBytes ?? 0,
  };
}
