-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.audit_logs (
  id bigint NOT NULL DEFAULT nextval('audit_logs_id_seq'::regclass),
  user_id bigint,
  action text NOT NULL,
  details jsonb,
  ip_address text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.product_contexts (
  product_id text NOT NULL,
  brand text,
  design_prompt text,
  design_details jsonb,
  placements jsonb,
  audience text,
  extra jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT product_contexts_pkey PRIMARY KEY (product_id)
);
CREATE TABLE public.products (
  id bigint NOT NULL DEFAULT nextval('products_id_seq'::regclass),
  title text NOT NULL,
  description text,
  price numeric,
  tags ARRAY,
  blueprint_id text,
  image_url text,
  ai_prompt text,
  ai_response jsonb,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT products_pkey PRIMARY KEY (id)
);
CREATE TABLE public.prompts (
  id bigint NOT NULL DEFAULT nextval('prompts_id_seq'::regclass),
  product_id text,
  prompt text NOT NULL,
  response jsonb,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT prompts_pkey PRIMARY KEY (id)
);
CREATE TABLE public.subscription_plans (
  id bigint NOT NULL DEFAULT nextval('subscription_plans_id_seq'::regclass),
  name text NOT NULL UNIQUE,
  price_cents integer NOT NULL DEFAULT 0,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subscription_plans_pkey PRIMARY KEY (id)
);
CREATE TABLE public.usage_tracking (
  id bigint NOT NULL DEFAULT nextval('usage_tracking_id_seq'::regclass),
  user_id bigint NOT NULL,
  type text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT usage_tracking_pkey PRIMARY KEY (id),
  CONSTRAINT usage_tracking_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_products (
  id bigint NOT NULL DEFAULT nextval('user_products_id_seq'::regclass),
  user_id bigint,
  title text NOT NULL,
  description text,
  product_data jsonb,
  ai_metadata jsonb,
  status text DEFAULT 'draft'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_products_pkey PRIMARY KEY (id),
  CONSTRAINT user_products_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_subscriptions (
  id bigint NOT NULL DEFAULT nextval('user_subscriptions_id_seq'::regclass),
  user_id bigint NOT NULL,
  plan_id bigint,
  status text NOT NULL DEFAULT 'inactive'::text,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT user_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id),
  CONSTRAINT user_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.users (
  id bigint NOT NULL DEFAULT nextval('users_id_seq'::regclass),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  first_name text,
  last_name text,
  company_name text,
  email_verified boolean DEFAULT false,
  verification_token text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  printify_api_key_encrypted text,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);