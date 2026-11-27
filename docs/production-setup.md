# LUMI AI production setup

## Required services

1. Create a Supabase project and configure its URL, anon key, and service-role key in the deployment environment.
2. Apply every SQL migration in `supabase/migrations` in filename order using the Supabase SQL editor or Supabase CLI.
3. Configure Replicate API token, image/video model identifiers, and each model's exact JSON input template. The model templates must use `{{prompt}}`, `{{aspect_ratio}}`, and optionally `{{image_url}}` placeholders.
4. Configure Stripe in live mode only after testing in Stripe test mode:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - Register `https://YOUR_LUMI_DOMAIN/api/billing/webhook` for `checkout.session.completed`.
5. Set `NEXT_PUBLIC_APP_URL` to the final HTTPS domain.

## Admin bootstrap

After the first account has signed in and its profile row exists, promote the intended operator explicitly in Supabase SQL:

```sql
update public.profiles
set role = 'admin', updated_at = now()
where id = 'THE_AUTH_USER_UUID';
```

Do not expose the service-role key in browser code. Admin adjustments are recorded in the credit ledger with a reason and an idempotency key.

## Credit packages

- Starter: 100 credits for USD $4.99
- Creator: 550 credits for USD $19.99
- Studio: 1,600 credits for USD $49.99

Checkout creates a Stripe-hosted one-time payment. Credits are granted only after a verified, paid `checkout.session.completed` webhook and are idempotent per Checkout Session.

## Deployment

The Render Blueprint is configured for the `main` branch. Add all required secrets to the Render service before approving the first sync. The Render web service is a paid Starter plan; Render requires billing details and explicit approval before creating billable infrastructure.

## Verification

GitHub Actions runs install, TypeScript type-check, lint, and production build. A passing CI build does not replace live tests for Supabase auth, storage, Replicate model compatibility, Stripe webhooks, and credit accounting.
