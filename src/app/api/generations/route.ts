
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPrediction } from "@/lib/providers/replicate";
import { generationRequestSchema } from "@/lib/generations/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  let supabase;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view your generations." }, { status: 401 });
  const url = new URL(request.url);
  const limit = Math.min(30, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "12", 10) || 12));
  const { data, error } = await supabase.from("generations")
    .select("id, kind, prompt, aspect_ratio, status, provider_status, error_message, created_at, updated_at, asset_path")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: "Could not load generation history." }, { status: 500 });
  return NextResponse.json({ generations: data || [] });
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = generationRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid generation request.", details: parsed.error.flatten() }, { status: 422 });

  const { kind, prompt, aspectRatio, referenceAssetPath } = parsed.data;
  const model = kind === "image" ? process.env.REPLICATE_IMAGE_MODEL : process.env.REPLICATE_VIDEO_MODEL;
  if (!process.env.REPLICATE_API_TOKEN || !model) {
    return NextResponse.json({
      code: "PROVIDER_NOT_CONFIGURED",
      error: `Real ${kind} generation is unavailable until the Replicate token and ${kind} model are configured.`
    }, { status: 503 });
  }

  let supabase;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Sign in to create media." }, { status: 401 });

  let referenceImageUrl: string | undefined;\n  if (referenceAssetPath) {\n    if (!referenceAssetPath.startsWith(`${user.id}/inputs/`) || referenceAssetPath.includes("..")) {\n      return NextResponse.json({ error: "Reference image does not belong to this account." }, { status: 403 });\n    }\n    try {\n      const admin = createAdminClient();\n      const { data, error } = await admin.storage.from("lumi-assets").createSignedUrl(referenceAssetPath, 3600);\n      if (error || !data) return NextResponse.json({ error: "Reference image is missing or unavailable." }, { status: 400 });\n      referenceImageUrl = data.signedUrl;\n    } catch {\n      return NextResponse.json({ error: "Reference image storage is unavailable." }, { status: 503 });\n    }\n  }\n\n  const amount = Number.parseInt(process.env[kind === "image" ? "LUMI_IMAGE_CREDIT_COST" : "LUMI_VIDEO_CREDIT_COST"] || (kind === "image" ? "1" : "10"), 10);
  if (!Number.isSafeInteger(amount) || amount < 1) return NextResponse.json({ error: "Generation credit cost is misconfigured." }, { status: 500 });

  const { data: job, error: insertError } = await supabase.from("generations")
    .insert({ user_id: user.id, kind, prompt, aspect_ratio: aspectRatio, reference_asset_path: referenceAssetPath || null, status: "queued", provider: "replicate" })
    .select("id, status, created_at").single();
  if (insertError || !job) return NextResponse.json({ error: "Could not create a generation job." }, { status: 500 });

  const { error: reserveError } = await supabase.rpc("reserve_generation_credits", { p_generation_id: job.id, p_amount: amount });
  if (reserveError) {
    await supabase.from("generations").delete().eq("id", job.id);
    const insufficient = reserveError.message.includes("INSUFFICIENT_CREDITS");
    return NextResponse.json({ error: insufficient ? "You do not have enough credits." : "Could not reserve generation credits." }, { status: insufficient ? 402 : 500 });
  }

  try {
    const prediction = await createPrediction(kind, prompt, aspectRatio, referenceImageUrl);
    const admin = createAdminClient();
    const nextStatus = prediction.status === "failed" || prediction.status === "canceled" ? "failed" : prediction.status === "succeeded" ? "storage_failed" : "processing";
    const { error: updateError } = await admin.from("generations").update({
      provider_prediction_id: prediction.id,
      provider_status: prediction.status,
      status: nextStatus,
      provider_output: prediction.output ?? null,
      error_message: prediction.error ?? null,
      updated_at: new Date().toISOString()
    }).eq("id", job.id).eq("user_id", user.id);
    if (updateError) throw new Error("The provider accepted the request but the job state could not be saved. Contact support with job ID " + job.id);

    if (nextStatus === "failed") {
      await admin.rpc("refund_generation_credits", { p_user_id: user.id, p_generation_id: job.id, p_amount: amount, p_reason: "provider_failed_on_submit" });
    }
    return NextResponse.json({ id: job.id, status: nextStatus, providerStatus: prediction.status }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The provider request failed.";
    try {
      const admin = createAdminClient();
      await admin.from("generations").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", job.id).eq("user_id", user.id);
      await admin.rpc("refund_generation_credits", { p_user_id: user.id, p_generation_id: job.id, p_amount: amount, p_reason: "provider_submission_failed" });
    } catch {
      // Preserve the original provider error; an operator can reconcile a failed refund from the ledger.
    }
    return NextResponse.json({ code: "PROVIDER_REQUEST_FAILED", error: message, jobId: job.id }, { status: 502 });
  }
}
