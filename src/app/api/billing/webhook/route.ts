import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CREDIT_PACKAGES, isCreditPackageId } from "@/lib/billing/packages";

export const runtime = "nodejs";

function verifySignature(raw: string, header: string, secret: string) {
  const parts = header.split(",").map((part) => part.split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || signatures.length === 0) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest();
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const supplied = Buffer.from(signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature") || "";
  if (!secret || !verifySignature(await request.clone().text(), signature, secret)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
  }
  const event = await request.json().catch(() => null);
  if (!event || event.type !== "checkout.session.completed") return NextResponse.json({ received: true });

  const session = event.data?.object;
  if (session?.payment_status !== "paid" || session?.mode !== "payment") return NextResponse.json({ received: true });
  const userId = session.metadata?.user_id;
  const packageId = session.metadata?.package_id;
  if (typeof userId !== "string" || typeof packageId !== "string" || !isCreditPackageId(packageId)) {
    return NextResponse.json({ error: "Checkout metadata is invalid." }, { status: 400 });
  }
  const pack = CREDIT_PACKAGES[packageId];
  if (Number(session.metadata?.credits) !== pack.credits || session.amount_total !== pack.amountCents || session.currency !== pack.currency) {
    return NextResponse.json({ error: "Checkout amount or credit metadata does not match the package." }, { status: 400 });
  }
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("apply_credit_purchase", {
      p_user_id: userId, p_credits: pack.credits, p_checkout_session_id: session.id
    });
    if (error) throw new Error(error.message);
  } catch {
    return NextResponse.json({ error: "Could not apply purchased credits. Stripe may retry this event." }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
