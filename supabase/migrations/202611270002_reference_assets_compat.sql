-- Safe additive migration for environments where the initial schema was already applied.
alter table public.generations
  add column if not exists reference_asset_path text;
