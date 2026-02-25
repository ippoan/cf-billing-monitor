// Cloudflare Billing REST API

export interface BillingEntry {
  id: string;
  type: string;
  occurred_at: string;
  amount: number;
  currency: string;
  receipt_id: string;
  status: string;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

export async function fetchBillingHistory(
  token: string,
  accountId: string,
): Promise<BillingEntry[]> {
  const resp = await fetch(`${API_BASE}/accounts/${accountId}/billing/history?per_page=10&order=occurred_at&direction=desc`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Billing API error: ${resp.status} ${text}`);
    return [];
  }

  const data = (await resp.json()) as {
    success: boolean;
    result?: BillingEntry[];
  };

  return data.result ?? [];
}
