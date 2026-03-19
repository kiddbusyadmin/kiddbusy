-- Remove public browser write policies now that public pages write through Netlify functions.

DROP POLICY IF EXISTS "Public insert analytics" ON public.analytics;

DROP POLICY IF EXISTS "Public update city_searches" ON public.city_searches;
DROP POLICY IF EXISTS "Public upsert city_searches" ON public.city_searches;

DROP POLICY IF EXISTS "Public insert email_leads" ON public.email_leads;

DROP POLICY IF EXISTS "Public insert events" ON public.events;
DROP POLICY IF EXISTS "Public update events" ON public.events;

DROP POLICY IF EXISTS "Public insert listings" ON public.listings;

DROP POLICY IF EXISTS "Public insert reviews" ON public.reviews;
