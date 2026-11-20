-- Persistent Daytona machine registry: survives controller restarts, with tenant RLS.
create table machines (
  tenant_id text not null,
  machine_id text primary key,
  name text not null,
  size text not null default 'small',
  state text not null,
  idle_minutes integer not null default 10,
  keep_awake boolean not null default false,
  next_scheduled_at bigint,
  labels jsonb not null default '{}'::jsonb,
  pending_resize jsonb,
  cache jsonb not null default '{}'::jsonb,
  epoch integer not null default 1,
  seq integer not null default 0,
  version bigint not null default 1,
  job_leases jsonb not null default '{}'::jsonb,
  sleep_lease jsonb,
  last_activity_at bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index machines_tenant_idx on machines (tenant_id, updated_at desc);

alter table machines enable row level security;
alter table machines force row level security;
create policy tenant_isolation on machines
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
