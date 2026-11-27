# Provider setup

## Replicate
LUMI's first adapter uses the Replicate HTTP API. Configure these server-side variables:
- `REPLICATE_API_TOKEN`: Replicate API token.
- `REPLICATE_IMAGE_MODEL`: configured image model identifier.
- `REPLICATE_VIDEO_MODEL`: configured video model identifier.
- `REPLICATE_WEBHOOK_SECRET`: webhook signing secret when webhook delivery is enabled.

Model identifiers are not hardcoded. Availability, input schemas, dimensions, durations and pricing vary by model. A missing token or model configuration must produce `PROVIDER_NOT_CONFIGURED`. Never return fabricated media.

## Supabase
Create a Supabase project, apply all SQL migrations in order, enable email authentication, create a private `lumi-assets` storage bucket, and configure the URL, anon key and service-role key in the server environment. The service-role key must never use a `NEXT_PUBLIC_` prefix.

## Launch gate
Run a real generation smoke test for each enabled modality before advertising it as available. Record model version, settings, prediction ID, output dimensions/duration and stored asset URL.
