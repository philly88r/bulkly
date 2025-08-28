-- Add sequence for generated_images table
CREATE SEQUENCE IF NOT EXISTS public.generated_images_id_seq;

-- Add table for storing AI-generated images permanently
CREATE TABLE IF NOT EXISTS public.generated_images (
    id bigint NOT NULL DEFAULT nextval('generated_images_id_seq'::regclass),
    user_id bigint NOT NULL,
    product_id text,
    prompt text NOT NULL,
    image_url text NOT NULL,
    printify_url text,
    model text,
    metadata jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT generated_images_pkey PRIMARY KEY (id),
    CONSTRAINT generated_images_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON public.generated_images(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_product_id ON public.generated_images(product_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_created_at ON public.generated_images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_images_status ON public.generated_images(status);

-- Add RLS policies
ALTER TABLE public.generated_images ENABLE ROW LEVEL SECURITY;

-- Users can only see their own generated images
CREATE POLICY "Users can view own images" ON public.generated_images
    FOR SELECT USING (auth.uid() = user_id);

-- Users can only insert their own generated images
CREATE POLICY "Users can insert own images" ON public.generated_images
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own generated images
CREATE POLICY "Users can update own images" ON public.generated_images
    FOR UPDATE USING (auth.uid() = user_id);

-- Add trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_generated_images_updated_at BEFORE UPDATE ON public.generated_images
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
