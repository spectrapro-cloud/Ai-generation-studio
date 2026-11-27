# LUMI AI

**Create Without Limits.**

LUMI AI is an independent, production-oriented AI image and video creation platform. It is intentionally separate from Spectra while keeping its modules and data boundaries suitable for a future integration.

## Product principles

- No demo generations, fake progress, sample outputs, or simulated provider responses.
- Image and video generation must use configured, real provider APIs.
- Missing provider configuration returns an explicit unavailable error.
- Every generation is an auditable job with ownership, provider state, timestamps, and failure details.
- Secrets stay server-side; never expose provider credentials to browser bundles.
- Media is not marked as permanently stored until it has been copied into configured object storage.
- Admin privileges and customer entitlements are enforced server-side.

## Initial stack

- Next.js App Router + TypeScript
- Supabase Auth + PostgreSQL + Storage
- Replicate as the first provider adapter for real image/video inference
- Server-side generation orchestration with persisted jobs
- Render deployment target (configured separately after the app is validated)

## Development status

This repository is the application foundation, not a claim that a deployed production service is already operational. Real generation requires Supabase and Replicate credentials, configured model identifiers, database migrations, storage setup, and deployment configuration.

See `docs/architecture.md`, `docs/provider-setup.md`, and `supabase/migrations`.
