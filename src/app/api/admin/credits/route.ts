import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type AdminAccess = { ok: true; user: { id: string }; admin: ReturnType<typeof createAdminClient> } | { ok: false; response: NextResponse };

async function requireAdmin(): Promise<AdminAccess> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return { ok: false, response: NextResponse.json({ error: "Administrator access is required." }, { status: 403 }) };
  return { ok: true, user, admin: createAdminClient() };
}

export async function GET() {
  try {
    const access = await requireAdmin();
    if (!access.ok) return access.response;
    const [{ data: authData, error: authError }, { data: profiles, error: profileError }] = await Promise.all([
      access.admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      access.admin.from("profiles").select("id,display_name,credits,role").order("created_at", { ascending: false }).limit(1000)
    ]);
    if (authError || profileError) return NextResponse.json({ error: "Could not load the user directory." }, { status: 500 });
    const emails = new Map((authData.users || []).map((item) => [item.id, item.email || ""]));
    return NextResponse.json({ users: (profiles || []).map((profile) => ({ ...profile, email: emails.get(profile.id) || "" })) });
  } catch {
    return NextResponse.json({ error: "Could not load administrator data." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let access: AdminAccess;
  try { access = await requireAdmin(); } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  if (!access.ok) return access.response;
  const body = await request.json().catch(() => ({})) as { userId?: string; amount?: number; reason?: string };
  if (!body.userId || !Number.isSafeInteger(body.amount) || !body.amount || Math.abs(body.amount) > 100000 ||
      typeof body.reason !== "string" || body.reason.trim().length < 5 || body.reason.length > 500) {
    return NextResponse.json({ error: "Choose a user and provide a non-zero credit amount and a reason of at least five characters." }, { status: 400 });
  }
  const { error } = await access.admin.rpc("admin_adjust_credits", {
    p_admin_id: access.user.id, p_user_id: body.userId, p_amount: body.amount,
    p_reason: body.reason.trim(), p_request_id: randomUUID()
  });
  if (error) return NextResponse.json({ error: error.message.includes("INSUFFICIENT_CREDITS") ? "That adjustment would make the balance negative." : "Could not apply the credit adjustment." }, { status: 400 });
  return NextResponse.json({ adjusted: true });
}
