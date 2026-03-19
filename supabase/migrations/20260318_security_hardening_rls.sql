-- Supabase security hardening
-- 1) Lock trigger functions to a fixed search_path.
-- 2) Replace permissive public RLS policies with scoped checks.
-- 3) Remove the unnecessary public submissions insert policy; submissions are handled by a server function.

alter function public.set_updated_at_sponsor_banners()
  set search_path = public, pg_temp;

alter function public.set_updated_at_cmo_social_tasks()
  set search_path = public, pg_temp;

-- analytics
DROP POLICY IF EXISTS "Public insert analytics" ON public.analytics;
CREATE POLICY "Public insert analytics" ON public.analytics
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    event IS NOT NULL
    AND length(trim(event)) BETWEEN 1 AND 120
    AND session_id IS NOT NULL
    AND length(trim(session_id)) BETWEEN 6 AND 160
    AND (city IS NULL OR length(trim(city)) <= 120)
    AND (source IS NULL OR source IN ('public', 'internal'))
    AND (path IS NULL OR length(path) <= 300)
  );

-- city_searches
DROP POLICY IF EXISTS "Public update city_searches" ON public.city_searches;
DROP POLICY IF EXISTS "Public upsert city_searches" ON public.city_searches;
CREATE POLICY "Public update city_searches" ON public.city_searches
  FOR UPDATE TO anon, authenticated
  USING (
    city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
  )
  WITH CHECK (
    city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
    AND last_searched IS NOT NULL
  );
CREATE POLICY "Public upsert city_searches" ON public.city_searches
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
    AND last_searched IS NOT NULL
  );

-- email_leads
DROP POLICY IF EXISTS "Public insert email_leads" ON public.email_leads;
CREATE POLICY "Public insert email_leads" ON public.email_leads
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    email IS NOT NULL
    AND email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND (city IS NULL OR length(trim(city)) <= 120)
    AND (source IS NULL OR source IN ('homepage_signup'))
  );

-- events
DROP POLICY IF EXISTS "Public insert events" ON public.events;
DROP POLICY IF EXISTS "Public update events" ON public.events;
CREATE POLICY "Public insert events" ON public.events
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
    AND name IS NOT NULL
    AND length(trim(name)) BETWEEN 1 AND 240
    AND source_url IS NOT NULL
    AND last_refreshed IS NOT NULL
  );
CREATE POLICY "Public update events" ON public.events
  FOR UPDATE TO anon, authenticated
  USING (
    city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
    AND name IS NOT NULL
    AND length(trim(name)) BETWEEN 1 AND 240
  )
  WITH CHECK (
    city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
    AND name IS NOT NULL
    AND length(trim(name)) BETWEEN 1 AND 240
    AND source_url IS NOT NULL
    AND last_refreshed IS NOT NULL
  );

-- listings
DROP POLICY IF EXISTS "Public insert listings" ON public.listings;
CREATE POLICY "Public insert listings" ON public.listings
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    name IS NOT NULL
    AND length(trim(name)) BETWEEN 1 AND 240
    AND city IS NOT NULL
    AND length(trim(city)) BETWEEN 1 AND 120
    AND status = 'active'
    AND source IN ('ai_generated', 'background_refresh')
    AND coalesce(is_sponsored, false) = false
    AND coalesce(review_count, 0) >= 0
    AND coalesce(rating, 0) >= 0
    AND coalesce(rating, 0) <= 5
  );

-- reviews
DROP POLICY IF EXISTS "Public insert reviews" ON public.reviews;
CREATE POLICY "Public insert reviews" ON public.reviews
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    listing_id IS NOT NULL
    AND reviewer_name IS NOT NULL
    AND length(trim(reviewer_name)) BETWEEN 1 AND 180
    AND rating >= 1
    AND rating <= 5
    AND source = 'user'
    AND status IN ('approved', 'pending')
  );

-- submissions are created via Netlify function using the service role.
DROP POLICY IF EXISTS "Public insert submissions" ON public.submissions;
