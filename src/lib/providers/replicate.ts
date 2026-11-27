export type MediaKind = "image" | "video";

export type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ProviderConfigurationError(name);
  return value;
}

export class ProviderConfigurationError extends Error {
  readonly code = "PROVIDER_NOT_CONFIGURED";
  constructor(variable: string) {
    super(`The real generation provider is not configured: ${variable} is missing.`);
    this.name = "ProviderConfigurationError";
  }
}

function modelFor(kind: MediaKind) {
  const raw = required(kind === "image" ? "REPLICATE_IMAGE_MODEL" : "REPLICATE_VIDEO_MODEL");
  if (!/^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(raw)) {
    throw new Error(`Invalid Replicate model identifier for ${kind}. Expected owner/model.`);
  }
  return raw;
}

function applyTemplate(templateText: string | undefined, values: Record<string, string>) {
  const fallback = { prompt: "{{prompt}}", aspect_ratio: "{{aspect_ratio}}" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(templateText || JSON.stringify(fallback));
  } catch {
    throw new Error("Provider input template must be valid JSON.");
  }
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/\{\{(prompt|aspect_ratio)\}\}/g, (_, key: string) => values[key] ?? "");
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  return replace(parsed);
}

async function replicateFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = required("REPLICATE_API_TOKEN");
  const response = await fetch(`https://api.replicate.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : `Replicate returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  return payload as T;
}

export async function createPrediction(kind: MediaKind, prompt: string, aspectRatio: string, imageUrl?: string) {
  const model = modelFor(kind);
  const template = process.env[kind === "image" ? "REPLICATE_IMAGE_INPUT_TEMPLATE" : "REPLICATE_VIDEO_INPUT_TEMPLATE"];
  const input = applyTemplate(template, { prompt, aspect_ratio: aspectRatio, image_url: imageUrl || "" });
  return replicateFetch<ReplicatePrediction>(`/models/${model}/predictions`, {
    method: "POST",
    headers: { Prefer: "wait=1" },
    body: JSON.stringify({ input })
  });
}

export async function getPrediction(id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid provider prediction ID.");
  return replicateFetch<ReplicatePrediction>(`/predictions/${encodeURIComponent(id)}`);
}
