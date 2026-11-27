# LUMI AI architecture

## Boundaries
LUMI is an independent product. It must not import Spectra application code, share Spectra credentials, or depend on Spectra databases. Future integration should happen through documented APIs and explicit identity/entitlement mapping.

## Request lifecycle
1. An authenticated user submits a generation request.
2. The server validates the request and checks available credits.
3. A generation record is created with status `queued`.
4. A provider adapter submits a real inference request.
5. The provider prediction ID and state are persisted.
6. The client reads persisted job state; it never fabricates progress.
7. Provider outputs are copied to private object storage before being labelled as stored assets.
8. Failure details are persisted and reserved credits are refunded idempotently.

## Core modules
- `src/lib/supabase`: browser/server Supabase clients
- `src/lib/providers`: provider-neutral contracts and provider adapters
- `src/app/api/generations`: authenticated generation and status APIs
- `src/app/studio`: customer workspace
- `supabase/migrations`: schema, RLS, credit ledger and RPC functions

## Security
- Provider tokens and service-role keys are server-only.
- User-owned rows use Row Level Security.
- API routes verify the authenticated user on every request.
- Credit operations are transactional and idempotent.
- Admin permissions are checked server-side.
- Uploads have size/type limits and private storage policies.
- Webhook signatures must be verified before they can mutate jobs.

## Reliability
- Provider errors are explicit, never replaced with successful placeholder results.
- Jobs are durable and survive browser refresh.
- Model identifiers are environment-configured and validated.
- Timeouts, retries and rate limits are bounded.
- A job is complete only after provider completion is confirmed.
