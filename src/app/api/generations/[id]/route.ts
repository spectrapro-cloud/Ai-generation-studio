import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrediction } from "@/lib/providers/replicate";
import { generationIdSchema } from "@/lib/generations/schema";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

function outputUrl(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    for (const key of ["url", "video", "image", "output"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return null;
}

async function storeOutput(userId: string, jobId: string, kind: "image" | "video", output: unknown) {
  const source = outputUrl(output);
  if (!source) throw new Error("Provider reported success but returned no downloadable media URL.");
  const parsed = new URL(source);
  if (parsed.protocol !== "https:" || !(parsed.hostname === "replicate.delivery" || parsed.hostname.endsWith(".replicate.delivery"))) {
    throw new Error("Provider output URL failed the trusted-host check.");
  }

  const response = await fetch(source, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(45_000) });
  if (response.status >= 300 && response.status < 400) throw new Error("Provider output attempted an unexpected redirect.");
  if (!response.ok) throw new Error(`Could not retrieve provider output (HTTP ${response.status}).`);
  const mime = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const allowed = kind === "image"
    ? ["image/png", "image/jpeg", "image/webp"]
    : ["video/mp4", "video/webm", "video/quicktime"];
  if (!allowed.includes(mime)) throw new Error(`Provider returned an unsupported media type: ${mime || "unknown"}.`);

  const maxBytes = kind === "image" ? 40 * 1024 * 1024 : 200 * 1024 * 1024;
  const declaredSize = Number(response.headers.get("content-length") || "0");
  if (declaredSize > maxBytes) throw new Error("Generated media exceeds the configured storage size limit.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error("Generated media exceeds the configured storage size limit.");
  const validImage = mime === "image/png"
    ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg" ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : mime === "image/webp" ? buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" : false;
  const validVideo = mime === "video/webm"
    ? buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : (mime === "video/mp4" || mime === "video/quicktime") && buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
  if (kind === "image" ? !validImage : !validVideo) throw new Error("Generated media bytes do not match the provider's declared media type.");

  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "video/webm" ? "webm" : mime === "video/quicktime" ? "mov" : "mp4";
  const path = `${userId}/${jobId}/original.${extension}`;
  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage.from("lumi-assets").upload(path, buffer, { contentType: mime, upsert: true });
  if (uploadError) throw new Error(`Media storage failed: ${uploadError.message}`);
  return { path, mime, bytes: buffer.byteLength };
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  if (!generationIdSchema.safeParse(id).success) return NextResponse.json({ error: "Invalid generation ID." }, { status: 400 });

  let supabase;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view this generation." }, { status: 401 });

  const { data: job, error } = await supabase.from("generations")
    .select("id,user_id,kind,prompt,aspect_ratio,status,provider_status,provider_prediction_id,provider_output,error_message,created_at,updated_at,asset_path,asset_mime_type,asset_bytes,credits_reserved")
    .eq("id", id).eq("user_id", user.id).single();
  if (error || !job) return NextResponse.json({ error: "Generation not found." }, { status: 404 });

  let current = job;
  if (job.provider_prediction_id && ["queued", "processing", "storage_failed"].includes(job.status)) {
    try {
      const prediction = await getPrediction(job.provider_prediction_id);
      const admin = createAdminClient();
      const nextStatus = prediction.status === "failed" || prediction.status === "canceled"
        ? "failed"
        : prediction.status === "succeeded" ? "storage_failed" : "processing";

      const { error: stateError } = await admin.from("generations").update({
        provider_status: prediction.status,
        status: nextStatus,
        provider_output: prediction.output ?? null,
        error_message: prediction.error ?? null,
        updated_at: new Date().toISOString()
      }).eq("id", id).eq("user_id", user.id);
      if (stateError) throw new Error("Could not persist provider status.");

      current = { ...job, provider_status: prediction.status, status: nextStatus, provider_output: prediction.output ?? null, error_message: prediction.error ?? null };

      if (nextStatus === "failed") {
        const { error: refundError } = await admin.rpc("refund_generation_credits", {
          p_user_id: user.id, p_generation_id: id, p_amount: job.credits_reserved, p_reason: "provider_generation_failed"
        });
        if (refundError && !refundError.message.includes("already")) throw new Error("Generation failed and credit reconciliation needs support review.");
      } else if (prediction.status === "succeeded") {
        try {
          const stored = await storeOutput(user.id, id, job.kind, prediction.output);
          const { error: assetError } = await admin.from("generations").update({
            status: "succeeded", asset_path: stored.path, asset_mime_type: stored.mime,
            asset_bytes: stored.bytes, error_message: null, updated_at: new Date().toISOString()
          }).eq("id", id).eq("user_id", user.id);
          if (assetError) throw new Error("Media was uploaded but the asset record could not be saved.");
          current = { ...current, status: "succeeded", asset_path: stored.path, asset_mime_type: stored.mime, asset_bytes: stored.bytes, error_message: null };
        } catch (storageError) {
          const reason = storageError instanceof Error ? storageError.message : "Could not persist generated media.";
          await admin.from("generations").update({ status: "storage_failed", error_message: reason, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", user.id);
          current = { ...current, status: "storage_failed", error_message: reason };
        }
      }
    } catch (pollError) {
      return NextResponse.json({ error: pollError instanceof Error ? pollError.message : "Could not check provider status.", jobId: id }, { status: 502 });
    }
  }

  let assetUrl: string | null = null;
  if (current.asset_path) {
    try {
      const admin = createAdminClient();
      const { data, error: signedError } = await admin.storage.from("lumi-assets").createSignedUrl(current.asset_path, 3600);
      if (!signedError) assetUrl = data.signedUrl;
    } catch {
      assetUrl = null;
    }
  }

  const { provider_output: _providerOutput, provider_prediction_id: _predictionId, user_id: _userId, ...safeJob } = current;
  return NextResponse.json({ ...safeJob, assetUrl });
}
