import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CREDIT_PACKAGES, isCreditPackageId } from "@/lib/billing/packages";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let supabase;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in before purchasing credits." }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { packageId?: string };
  if (!body.packageId || !isCreditPackageId(body.packageId)) {
    return NextResponse.json({ error: "Choose a valid credit package." }, { status: 400 });
  }
  const secret = process.env.STRIPE_SECRET_KEY;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!secret || !appUrl) return NextResponse.json({ error: "Credit checkout is not configured yet." }, { status: 503 });

  const selected = CREDIT_PACKAGES[body.packageId];
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${appUrl}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/?purchase=cancelled`,
    customer_email: user.email || "",
    client_reference_id: user.id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": selected.currency,
    "line_items[0][price_data][unit_amount]": String(selected.amountCents),
    "line_items[0][price_data][product_data][name]": selected.name,
    "metadata[user_id]": user.id,
    "metadata[credits]": String(selected.credits),
    "metadata[package_id]": body.packageId,
    "payment_intent_data[metadata][user_id]": user.id,
    "payment_intent_data[metadata][credits]": String(selected.credits)
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.url !== "string") {
    return NextResponse.json({ error: "Stripe could not start checkout. Check the billing configuration." }, { status: 502 });
  }
  return NextResponse.json({ url: payload.url });
}
