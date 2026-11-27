import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let supabase;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Administrator access is required." }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { userId?: string; amount?: number; reason?: string };
  if (!body.userId || !Number.isSafeInteger(body.amount) || !body.amount || Math.abs(body.amount) > 100000 ||
      typeof body.reason !== "string" || body.reason.trim().length < 5 || body.reason.length > 500) {
    return NextResponse.json({ error: "Provide a target user ID, a non-zero credit amount and a reason of at least five characters." }, { status: 400 });
  }
  const admin = createAdminClient();
  const { error } = await admin.rpc("admin_adjust_credits", {
    p_admin_id: user.id, p_user_id: body.userId, p_amount: body.amount,
    p_reason: body.reason.trim(), p_request_id: randomUUID()
  });
  if (error) return NextResponse.json({ error: error.message.includes("INSUFFICIENT_CREDITS") ? "That adjustment would make the balance negative." : "Could not apply the credit adjustment." }, { status: 400 });
  return NextResponse.json({ adjusted: true });
}
