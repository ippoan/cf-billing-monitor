// Supabase Management API — DB サイズ取得

const SUPABASE_API = "https://api.supabase.com/v1";
const PROJECT_REF = "tvbjvhvslgdwwlhpkezh";

export interface SupabaseUsage {
  dbSizeMB: number;       // 現在の DB サイズ (MB)
  dbLimitMB: number;      // Pro プラン上限 8 GB = 8192 MB
  planCost: number;       // $25/月 (固定)
  computeCost: number;    // Micro Compute 月額
  computeCredits: number; // $10 クレジット
}

export async function fetchSupabaseUsage(pat: string): Promise<SupabaseUsage | null> {
  if (!pat) {
    console.warn("SUPABASE_PAT not set, skipping Supabase metrics");
    return null;
  }

  const dbSizeMB = await fetchDbSize(pat);
  if (dbSizeMB === null) return null;

  return {
    dbSizeMB,
    dbLimitMB: 8 * 1024, // 8 GB
    planCost: 25.00,
    computeCost: 0.01528, // Micro instance ~$0.01528/月 (730h * $0.01021/h)
    computeCredits: 10.00,
  };
}

async function fetchDbSize(pat: string): Promise<number | null> {
  const url = `${SUPABASE_API}/projects/${PROJECT_REF}/database/query`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "SELECT pg_database_size('postgres') as size_bytes",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Supabase API error ${resp.status}: ${text}`);
      return null;
    }

    const data = await resp.json() as unknown;
    console.log("Supabase DB size response:", JSON.stringify(data));

    // レスポンス形式に応じてパース（形式が不明なため複数パターン対応）
    let sizeBytes: number | null = null;

    if (Array.isArray(data) && data.length > 0) {
      // [{ size_bytes: 123456 }] 形式
      const row = data[0] as Record<string, unknown>;
      sizeBytes = Number(row.size_bytes ?? row.pg_database_size);
    } else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.rows) && obj.rows.length > 0) {
        // { rows: [{ size_bytes: 123456 }] } 形式
        const row = obj.rows[0] as Record<string, unknown>;
        sizeBytes = Number(row.size_bytes ?? row.pg_database_size);
      } else if (Array.isArray(obj.result) && obj.result.length > 0) {
        // { result: [{ size_bytes: 123456 }] } 形式
        const row = obj.result[0] as Record<string, unknown>;
        sizeBytes = Number(row.size_bytes ?? row.pg_database_size);
      }
    }

    if (sizeBytes === null || isNaN(sizeBytes)) {
      console.error("Failed to parse DB size from response:", JSON.stringify(data));
      return null;
    }

    return sizeBytes / (1024 * 1024); // bytes → MB
  } catch (err) {
    console.error("Supabase fetch error:", err);
    return null;
  }
}
