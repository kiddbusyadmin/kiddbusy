create table if not exists public.blog_posts (
  id bigserial primary key,
  slug text not null unique,
  title text not null,
  excerpt text not null,
  body_html text not null,
  seo_description text not null,
  tags jsonb not null default '[]'::jsonb,
  city text,
  status text not null default 'published' check (status in ('draft','published','archived')),
  source text not null default 'cmo_seed',
  author text not null default 'CMO Agent',
  read_minutes integer not null default 4,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_posts_status_published_at
  on public.blog_posts(status, published_at desc);

create index if not exists idx_blog_posts_city
  on public.blog_posts(city);

insert into public.blog_posts (slug, title, excerpt, body_html, seo_description, tags, city, source, author, read_minutes, status, published_at)
values
(
  'weekend-playbook-free-fun-houston',
  'Houston Weekend Playbook: 9 Free and Low-Cost Kid Activities',
  'A parent-first guide to a full Houston weekend without overspending.',
  '<p>If your weekends fill up fast, this is your simple Houston plan: one active stop, one quiet stop, one easy meal break, and one backup plan for rain.</p><h2>Saturday plan</h2><p>Start with an early park visit before the heat, then pick one indoor museum or library branch for late morning.</p><h2>Sunday plan</h2><p>Choose one neighborhood event and keep the afternoon open for unstructured play. Kids usually need downtime to avoid meltdowns.</p><h2>Parent tip</h2><p>Pack snacks, backup clothes, and a water refill bottle so you can stay flexible without extra purchases.</p>',
  'Plan a stress-free Houston weekend with free and low-cost kid activities parents can do in one flexible route.',
  '["houston","weekend","free","family activities"]'::jsonb,
  'Houston',
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
),
(
  'rainy-day-kid-activities-dallas',
  'Rainy Day Kid Activities in Dallas That Actually Work',
  'Indoor Dallas options when weather cancels your original plan.',
  '<p>Rainy weekends do not need to become screen-only weekends. The key is picking places with enough movement built in.</p><h2>Best structure</h2><p>Combine one high-energy indoor activity with one calm activity like story time or crafts.</p><h2>Timing guide</h2><p>Arrive at opening time to avoid lines and leave before nap-time traffic picks up.</p><h2>Backup plan</h2><p>Keep one nearby cafe or snack stop in mind so transitions stay smooth.</p>',
  'Dallas rainy day guide for parents looking for indoor kid activities with less stress and better timing.',
  '["dallas","indoor","rainy day","parents"]'::jsonb,
  'Dallas',
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
),
(
  'best-austin-playgrounds-weekend-loop',
  'Best Austin Playgrounds: A Weekend Loop for Toddlers to Big Kids',
  'A practical route to rotate playgrounds by age and energy level.',
  '<p>Austin has excellent playground variety, but distance can drain your day. Group stops by area to reduce car time.</p><h2>Morning slot</h2><p>Pick one shaded playground and one splash-friendly stop.</p><h2>Afternoon slot</h2><p>Use a smaller neighborhood park for low-pressure play and quicker exits.</p><h2>What to pack</h2><p>Sunscreen, towels, and dry shirts make same-day transitions easier.</p>',
  'Austin weekend playground route ideas for families with toddlers and school-age kids.',
  '["austin","playgrounds","weekend","kids"]'::jsonb,
  'Austin',
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
),
(
  'san-antonio-family-weekend-no-overplanning',
  'San Antonio Family Weekend Plan (Without Overplanning)',
  'Simple structure for parents who want fun without a packed schedule.',
  '<p>Parents do not need 12 activities. Two anchor activities and open buffer time create better weekends.</p><h2>Try this format</h2><p>One morning outing, lunch reset, and one afternoon option close to home.</p><h2>Why this works</h2><p>Kids get enough novelty without reaching the overstimulated stage.</p><h2>Parent rule</h2><p>Leave one block unscheduled and let kids choose how to spend it.</p>',
  'Build an easier San Antonio weekend routine with fewer activities and better family pacing.',
  '["san antonio","family weekend","kids","parent tips"]'::jsonb,
  'San Antonio',
  'cmo_seed',
  'CMO Agent',
  3,
  'published',
  now()
),
(
  'phoenix-heat-proof-weekend-kid-ideas',
  'Phoenix Heat-Proof Weekend Ideas for Kids',
  'How to plan around heat while keeping kids active and happy.',
  '<p>In Phoenix, timing matters more than anything. Build your day around cool windows and indoor resets.</p><h2>Morning</h2><p>Outdoor play before late morning heat, then transition to shaded or indoor options.</p><h2>Midday</h2><p>Use indoor activities and snack breaks to protect energy.</p><h2>Evening</h2><p>Short outdoor return visits can work when temperatures drop.</p>',
  'Phoenix weekend activity planning for families who need indoor and early-morning options in hot weather.',
  '["phoenix","heat","weekend","family"]'::jsonb,
  'Phoenix',
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
),
(
  'charlotte-weekend-activities-preschoolers',
  'Charlotte Weekend Activities for Preschoolers',
  'Age-appropriate ideas that balance movement, learning, and downtime.',
  '<p>Preschoolers do best with short activity blocks and frequent breaks. Keep transitions simple and local.</p><h2>Suggested rhythm</h2><p>One sensory activity, one movement activity, then a calm reset.</p><h2>Duration</h2><p>Aim for 60 to 90 minutes per outing to avoid fatigue.</p><h2>Family bonus</h2><p>Choose places with sibling-friendly options to reduce split planning.</p>',
  'Charlotte weekend guide for preschool family activities with practical timing and pacing tips.',
  '["charlotte","preschool","weekend","family activities"]'::jsonb,
  'Charlotte',
  'cmo_seed',
  'CMO Agent',
  3,
  'published',
  now()
),
(
  'atlanta-budget-friendly-weekend-kids',
  'Atlanta Budget-Friendly Weekend Activities for Kids',
  'Parent-tested ways to keep weekends fun and affordable.',
  '<p>Budget-friendly weekends are easier when you plan one paid anchor activity and fill the rest with free stops.</p><h2>Cost strategy</h2><p>Use memberships where possible and pair them with nearby parks.</p><h2>Energy strategy</h2><p>Alternate active and calm activities to keep kids regulated.</p><h2>Planning tip</h2><p>Save one no-cost backup option in case your first stop is crowded.</p>',
  'Atlanta low-cost family weekend ideas with practical scheduling and spending tips for parents.',
  '["atlanta","budget","weekend","kids"]'::jsonb,
  'Atlanta',
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
),
(
  'nashville-weekend-kids-music-art-play',
  'Nashville Weekend Guide: Music, Art, and Play for Kids',
  'A balanced weekend template for curious kids in Nashville.',
  '<p>Nashville weekends can combine creativity and movement with very little friction when stops are grouped intentionally.</p><h2>Morning focus</h2><p>Start with art or music-focused activities while attention is high.</p><h2>Afternoon focus</h2><p>Switch to active play and outdoor time.</p><h2>Parent tip</h2><p>Keep drive times short and avoid stacking too many ticketed events.</p>',
  'Nashville family weekend ideas mixing creative and active kid-friendly activities.',
  '["nashville","weekend","music","kids"]'::jsonb,
  'Nashville',
  'cmo_seed',
  'CMO Agent',
  3,
  'published',
  now()
),
(
  'orlando-weekend-beyond-theme-parks',
  'Orlando Weekend with Kids (Beyond Theme Parks)',
  'Local-friendly ideas when you want a simpler weekend close to home.',
  '<p>You do not need a major park day every weekend. Orlando has plenty of lower-intensity family options.</p><h2>Try a split day</h2><p>Use one nature stop plus one indoor educational stop.</p><h2>Avoid burnout</h2><p>Leave extra transition time and skip long lines when possible.</p><h2>Parent win</h2><p>Kids often enjoy familiar, repeatable routines more than all-day marathons.</p>',
  'Orlando weekend family activities that are easier and lower-cost than full theme park days.',
  '["orlando","weekend","local","family"]'::jsonb,
  'Orlando',
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
),
(
  'family-weekend-planning-template-any-city',
  'The 2-2-1 Weekend Planning Template for Any Family',
  'Use this repeatable framework to simplify family weekends in any city.',
  '<p>The 2-2-1 template is simple: two activity options, two backup options, one non-negotiable rest block.</p><h2>Why parents like it</h2><p>It reduces decision fatigue and keeps weekends flexible.</p><h2>How to apply it</h2><p>Pick your top two activities Friday night, then pre-load two backups in case weather or crowds shift plans.</p><h2>Final step</h2><p>Commit to one rest block so everyone resets.</p>',
  'A repeatable family weekend planning template parents can use in any city to reduce stress and increase fun.',
  '["planning","weekend","parents","template"]'::jsonb,
  null,
  'cmo_seed',
  'CMO Agent',
  4,
  'published',
  now()
)
on conflict (slug) do nothing;
