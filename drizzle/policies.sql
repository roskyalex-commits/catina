-- Row Level Security for Cătină.
--
-- Runtime access goes through PostgREST with the caller's Supabase JWT, so these
-- policies are the actual tenancy boundary — not application code. Applied after
-- every `drizzle-kit push`/migration via `npm run db:policies`.
--
-- Rule of thumb: if a table has `org_id`, a member of that org may read and write
-- it. `companies`, `people`, `emails` and `signals` are shared reference data:
-- readable by any authenticated user, writable only by the service role, because
-- registry and crawl data is public and caching it once keeps us inside free-tier
-- rate limits.

-- Helper: the set of orgs the current JWT belongs to.
-- SECURITY DEFINER + a locked search_path so it can read memberships without
-- recursing into memberships' own policy.
create or replace function public.current_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.memberships where user_id = auth.uid()
$$;

revoke all on function public.current_org_ids() from public;
grant execute on function public.current_org_ids() to authenticated;

-- ---------------------------------------------------------------- tenant tables

do $$
declare
  t text;
  tenant_tables text[] := array[
    'agents',
    'lists',
    'leads',
    'campaigns',
    'messages',
    'suppressions',
    'job_runs'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_all', t);
    execute format($p$
      create policy %I on public.%I
        for all
        to authenticated
        using (org_id in (select public.current_org_ids()))
        with check (org_id in (select public.current_org_ids()))
    $p$, t || '_member_all', t);
  end loop;
end $$;

-- list_members: no org_id of its own — a membership row is reachable exactly when
-- its list is. Written as an exists() against `lists` rather than a join on
-- `leads` so a lead moved between lists cannot leak across the tenancy boundary.
alter table public.list_members enable row level security;
drop policy if exists list_members_member_all on public.list_members;
create policy list_members_member_all on public.list_members
  for all to authenticated
  using (
    exists (
      select 1 from public.lists l
      where l.id = list_members.list_id
        and l.org_id in (select public.current_org_ids())
    )
  )
  with check (
    exists (
      select 1 from public.lists l
      where l.id = list_members.list_id
        and l.org_id in (select public.current_org_ids())
    )
  );

-- orgs: visible to members; creation handled by the service role during signup.
alter table public.orgs enable row level security;
drop policy if exists orgs_member_read on public.orgs;
create policy orgs_member_read on public.orgs
  for select to authenticated
  using (id in (select public.current_org_ids()));

drop policy if exists orgs_admin_update on public.orgs;
create policy orgs_admin_update on public.orgs
  for update to authenticated
  using (
    exists (
      select 1 from public.memberships m
      where m.org_id = orgs.id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- memberships: a user sees rows for orgs they belong to.
alter table public.memberships enable row level security;
drop policy if exists memberships_member_read on public.memberships;
create policy memberships_member_read on public.memberships
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

-- sequence_steps has no org_id of its own; it inherits via its campaign.
alter table public.sequence_steps enable row level security;
drop policy if exists sequence_steps_member_all on public.sequence_steps;
create policy sequence_steps_member_all on public.sequence_steps
  for all to authenticated
  using (
    exists (
      select 1 from public.campaigns c
      where c.id = sequence_steps.campaign_id
        and c.org_id in (select public.current_org_ids())
    )
  )
  with check (
    exists (
      select 1 from public.campaigns c
      where c.id = sequence_steps.campaign_id
        and c.org_id in (select public.current_org_ids())
    )
  );

-- ------------------------------------------------------- shared reference data
-- Public registry + crawl data. Read-only to users; the workers write it using
-- the service role, which bypasses RLS.

do $$
declare
  t text;
  shared_tables text[] := array['companies', 'people', 'emails', 'signals', 'company_scans'];
begin
  foreach t in array shared_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format($p$
      create policy %I on public.%I
        for select
        to authenticated
        using (true)
    $p$, t || '_read', t);
  end loop;
end $$;

-- ------------------------------------------------------------- secrets: deny all
-- OAuth refresh tokens and the credit ledger are service-role only. RLS is
-- enabled with no permissive policy, so PostgREST returns nothing to any user
-- JWT even if a query slips through the application layer.

alter table public.email_accounts enable row level security;
drop policy if exists email_accounts_no_access on public.email_accounts;

alter table public.provider_usage enable row level security;
drop policy if exists provider_usage_no_access on public.provider_usage;

-- ------------------------------------------------------ provider credit ledger
-- Atomic increment for the enrichment waterfall's free-tier budget check.
--
-- The application must not read-modify-write this counter: enrichment runs
-- concurrently by design, and lost updates would let a free tier be overspent
-- into 429s — the exact failure the ledger exists to prevent.
create or replace function public.increment_provider_usage(
  p_org_id uuid,
  p_provider text,
  p_period_month text,
  p_amount integer,
  p_limit integer default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.provider_usage
    (org_id, provider, period_month, credits_used, credits_limit, last_call_at)
  values
    (p_org_id, p_provider, p_period_month, p_amount, p_limit, now())
  on conflict (org_id, provider, period_month) do update
    set credits_used = public.provider_usage.credits_used + excluded.credits_used,
        credits_limit = coalesce(excluded.credits_limit, public.provider_usage.credits_limit),
        last_call_at = now();
$$;

-- Service-role only: provider_usage denies all user access via RLS, and this
-- function is SECURITY DEFINER, so it must not be callable by an end user.
revoke all on function public.increment_provider_usage(uuid, text, text, integer, integer) from public;
revoke all on function public.increment_provider_usage(uuid, text, text, integer, integer) from authenticated;
