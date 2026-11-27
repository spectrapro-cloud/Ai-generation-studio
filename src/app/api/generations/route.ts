import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPrediction, ProviderConfigurationError } from "@/lib/providers/replicate";
import { generationRequestSchema } from "@/lib/generations/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = generationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid generation request.", details: parsed.error.flatten() }, { status: 422 });
  }

  const { kind, prompt, aspectRatio } = parsed.data;
  const providerModel = kind === "image" ? process.env.REPLICATE_IMAGE_MODEL : process.env.REPLICATE_VIDEO_MODEL;
  if (!process.env.REPLICATE_API_TOKEN || !providerModel) {
    return NextResponse.json({
      code: "PROVIDER_NOT_CONFIGURED",
      error: `Real ${kind} generation is unavailable until the Replicate token and ${kind} model are configured.`
    }, { status: 503 });
  }

  let supabase;
  try { supabase = await createClient(); } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Authentication service is unavailable." }, { status: 503 });
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Sign in to create media." }, { status: 401 });

  const amount = Number.parseInt(process.env[kind === "image" ? "LUMI_IMAGE_CREDIT_COST" : "LUMI_VIDEO_CREDIT_COST"] || (kind === "image" ? "1" : "10"), 10);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return NextResponse.json({ error: "The generation credit cost is misconfigured." }, { status: 500 });
  }

  const { data: job, error: insertError } = await supabase
    .from("generations")
    .insert({ user_id: user.id, kind, prompt, aspect_ratio: aspectRatio, status: "queued", provider: "replicate", credits_reserved: amount })
    .select("id, status, created_at")
    .single();

  if (insertError || !job) {
    return NextResponse.json({ error: "Could not create a generation job.", detail: insertError?.message }, { status: 500 });
  }

  const { error: reserveError } = await supabase.rpc("reserve_generation_credits", {
    p_generation_id: job.id,
    p_amount: amount
  });

  if (reserveError) {
    await supabase.from("generations").delete().eq("id", job.id);
    return NextResponse.json({ error: reserveError.message.includes("INSUFFICIENT_CREDITS") ? "You do not have enough credits." : "Could not reserve generation credits." }, { status: 402 });
  }

  try {
    const prediction = await createPrediction(kind, prompt, aspectRatio);
    const status = prediction.status === "succeeded" ? "succeeded" : prediction.status === "failed" || prediction.status === "canceled" ? "failed" : "processing";
    const { error: updateError } = await supabase.from("generations").update({
      provider_prediction_id: prediction.id,
      provider_status: prediction.status,
      status,
      provider_output: prediction.output ?? null,
      error_message: prediction.error ?? null,
      updated_at: new Date().toISOString()
    }).eq("id", job.id);

    if (updateError) throw new Error("Provider accepted the job, but its ID could not be saved. Contact support with job ID " + job.id);

    if (status === "failed") {
      await supabase.rpc("refund_generation_credits", { p_generation_id: job.id, p_amount: amount, p_reason: "provider_failed_on_submit" });
    }

    return NextResponse.json({ id: job.id, status, providerStatus: prediction.status }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The provider request failed.";
    await supabase.from("generations").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", job.id);
    await supabase.rpc("refund_generation_credits", { p_generation_id: job.id, p_amount: amount, p_reason: "provider_submission_failed" });
    const code = error instanceof ProviderConfigurationError ? error.code : "PROVIDER_REQUEST_FAILED";
    return NextResponse.json({ code, error: message, jobId: job.id }, { status: 502 });
  }
}
