-- Migration: add Printful credential columns to users table
-- Safe to run multiple times (IF NOT EXISTS guards)

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS printful_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS printful_access_token_encrypted text,
  ADD COLUMN IF NOT EXISTS printful_refresh_token_encrypted text,
  ADD COLUMN IF NOT EXISTS printful_token_expires_at timestamptz;
