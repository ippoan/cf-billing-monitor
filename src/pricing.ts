// Cloudflare 料金定数（2026-02 時点の公開料金）
// https://developers.cloudflare.com/workers/platform/pricing/
// https://developers.cloudflare.com/r2/pricing/
// https://developers.cloudflare.com/durable-objects/platform/pricing/
// https://developers.cloudflare.com/containers/pricing/

export const PRICING = {
  workers: {
    freeRequests: 10_000_000,    // 10M req/月
    freeCpuMs: 30_000_000,       // 30M CPU ms/月
    costPerMillionRequests: 0.30,
    costPerMillionCpuMs: 0.02,
  },
  r2: {
    freeStorageGB: 10,
    freeClassAOps: 1_000_000,    // 1M/月 (PUT, POST, LIST, etc.)
    freeClassBOps: 10_000_000,   // 10M/月 (GET, HEAD)
    costPerGBMonth: 0.015,
    costPerMillionClassA: 4.50,
    costPerMillionClassB: 0.36,
  },
  durableObjects: {
    freeRequests: 1_000_000,
    freeDurationGBs: 400_000,
    freeStorageGB: 1,
    costPerMillionRequests: 0.15,
    costPerMillionDurationGBs: 12.50,
    costPerGBMonth: 0.20,
  },
  kv: {
    freeReads: 10_000_000,
    freeWrites: 1_000_000,
    freeStorageGB: 1,
    costPerMillionReads: 0.50,
    costPerMillionWrites: 5.00,
    costPerGBMonth: 0.50,
  },
  containers: {
    costPerVCPUSecond: 0.00002,
    costPerGiBSecond: 0.0000025,
    costPerGBDiskSecond: 0.00000007,
    costPerGBEgress: 0.05,
  },
} as const;

export interface ServiceCost {
  service: string;
  usage: Record<string, number>;
  estimatedCost: number;
  withinFree: boolean;
}

export function calculateWorkersCost(totalRequests: number, totalCpuMs: number): ServiceCost {
  const reqOverage = Math.max(0, totalRequests - PRICING.workers.freeRequests);
  const cpuOverage = Math.max(0, totalCpuMs - PRICING.workers.freeCpuMs);
  const cost =
    (reqOverage / 1_000_000) * PRICING.workers.costPerMillionRequests +
    (cpuOverage / 1_000_000) * PRICING.workers.costPerMillionCpuMs;
  return {
    service: "Workers",
    usage: { requests: totalRequests, cpuMs: totalCpuMs },
    estimatedCost: cost,
    withinFree: cost === 0,
  };
}

export function calculateR2Cost(storageGB: number, classAOps: number, classBOps: number): ServiceCost {
  const storageOverage = Math.max(0, storageGB - PRICING.r2.freeStorageGB);
  const classAOverage = Math.max(0, classAOps - PRICING.r2.freeClassAOps);
  const classBOverage = Math.max(0, classBOps - PRICING.r2.freeClassBOps);
  const cost =
    storageOverage * PRICING.r2.costPerGBMonth +
    (classAOverage / 1_000_000) * PRICING.r2.costPerMillionClassA +
    (classBOverage / 1_000_000) * PRICING.r2.costPerMillionClassB;
  return {
    service: "R2",
    usage: { storageGB, classAOps, classBOps },
    estimatedCost: cost,
    withinFree: cost === 0,
  };
}

export function calculateDOCost(requests: number, durationGBs: number, storageGB: number): ServiceCost {
  const reqOverage = Math.max(0, requests - PRICING.durableObjects.freeRequests);
  const durOverage = Math.max(0, durationGBs - PRICING.durableObjects.freeDurationGBs);
  const storageOverage = Math.max(0, storageGB - PRICING.durableObjects.freeStorageGB);
  const cost =
    (reqOverage / 1_000_000) * PRICING.durableObjects.costPerMillionRequests +
    (durOverage / 1_000_000) * PRICING.durableObjects.costPerMillionDurationGBs +
    storageOverage * PRICING.durableObjects.costPerGBMonth;
  return {
    service: "Durable Objects",
    usage: { requests, durationGBs, storageGB },
    estimatedCost: cost,
    withinFree: cost === 0,
  };
}

export function calculateKVCost(reads: number, writes: number, storageGB: number): ServiceCost {
  const readOverage = Math.max(0, reads - PRICING.kv.freeReads);
  const writeOverage = Math.max(0, writes - PRICING.kv.freeWrites);
  const storageOverage = Math.max(0, storageGB - PRICING.kv.freeStorageGB);
  const cost =
    (readOverage / 1_000_000) * PRICING.kv.costPerMillionReads +
    (writeOverage / 1_000_000) * PRICING.kv.costPerMillionWrites +
    storageOverage * PRICING.kv.costPerGBMonth;
  return {
    service: "KV",
    usage: { reads, writes, storageGB },
    estimatedCost: cost,
    withinFree: cost === 0,
  };
}

export function calculateContainersCost(
  vcpuSeconds: number,
  memoryGiBSeconds: number,
): ServiceCost {
  const cost =
    vcpuSeconds * PRICING.containers.costPerVCPUSecond +
    memoryGiBSeconds * PRICING.containers.costPerGiBSecond;
  return {
    service: "Containers",
    usage: { vcpuSeconds, memoryGiBSeconds },
    estimatedCost: cost,
    withinFree: false,
  };
}
