import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPrediction } from "@/lib/providers/replicate";
import { generationIdSchema } from "@/lib/generations/schema";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

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
    .select("id, kind, prompt, aspect_ratio, status, provider_status, provider_output, error_message, created_at, updated_at, asset_path")
    .eq("id", id).eq("user_id", user.id).single();

  if (error || !job) return NextResponse.json({ error: "Generation not found." }, { status: 404 });

  if (job.provider_prediction_id && ["queued", "processing"].includes(job.status)) {
    try {
      const prediction = await getPrediction(job.provider_prediction_id);
      const terminal = ["succeeded", "failed", "canceled"].includes(prediction.status);
      const nextStatus = prediction.status === "succeeded" ? "succeeded" : prediction.status === "failed" || prediction.status === "canceled" ? "failed" : "processing";
      const update: Record<string, unknown> = {
        provider_status: prediction.status,
        status: nextStatus,
        provider_output: prediction.output ?? null,
        error_message: prediction.error ?? null,
        updated_at: new Date().toISOString()
      };
      const { error: updateError } = await supabase.from("generations").update(update).eq("id", id).eq("user_id", user.id);
      if (updateError) return NextResponse.json({ error: "Could not persist provider status." }, { status: 500 });
      if (terminal && nextStatus === "failed") {
        await supabase.rpc("refund_generation_credits", {
          p_generation_id: id,
          p_amount: Number(job.kind === "image" ? process.env.LUMI_IMAGE_CREDIT_COST || 1 : process.env.LUMI_VIDEO_CREDIT_COST || 10),
          p_reason: "provider_generation_failed"
        });
      }
      return NextResponse.json({ ...job, ...update, id, provider_prediction_id: undefined });
    } catch (pollError) {
      return NextResponse.json({ error: pollError instanceof Error ? pollError.message : "Could not check provider status.", jobId: id }, { status: 502 });
    }
  }

  return NextResponse.json(job);
}
