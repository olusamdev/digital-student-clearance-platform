-- Taraba State College of Health Technology, Takum
-- Digital Student Clearance Platform - foundational schema
-- SECURITY: RLS is enabled without broad client policies. Do not connect a public
-- frontend or import real student data until scoped policies/server operations exist.
begin;
create extension if not exists pgcrypto;

do $$ begin create type public.app_role as enum ('superadmin','admin','clearance_officer','unit_head','registrar','provost','certification_officer'); exception when duplicate_object then null; end $$;
do $$ begin create type public.clearance_status as enum ('not_requested','requested','cleared','needs_attention'); exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_status as enum ('initiated','pending','successful','failed','reversed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.final_assent_status as enum ('pending','assented','declined','revoked'); exception when duplicate_object then null; end $$;
do $$ begin create type public.certification_status as enum ('eligible','processing','statement_ready','certificate_ready','completed','on_hold'); exception when duplicate_object then null; end $$;

create table public.staff_profiles (
 user_id uuid primary key references auth.users(id) on delete restrict,
 full_name text not null, staff_number text unique, email text,
 active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.departments (
 id uuid primary key default gen_random_uuid(), code text unique, name text not null unique,
 active boolean not null default true, created_at timestamptz not null default now()
);
create table public.programmes (
 id uuid primary key default gen_random_uuid(), department_id uuid not null references public.departments(id) on delete restrict,
 code text, name text not null, cadre text, active boolean not null default true, created_at timestamptz not null default now(),
 unique(department_id,name), unique(department_id,code)
);
create table public.clearance_offices (
 id uuid primary key default gen_random_uuid(), code text not null unique, name text not null unique,
 description text, active boolean not null default true, display_order integer not null default 100, created_at timestamptz not null default now()
);
create table public.staff_role_assignments (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.staff_profiles(user_id) on delete restrict,
 role public.app_role not null, office_id uuid references public.clearance_offices(id) on delete restrict,
 active boolean not null default true, created_at timestamptz not null default now(), created_by uuid references auth.users(id) on delete set null,
 unique(user_id,role,office_id)
);
create table public.student_records (
 id uuid primary key default gen_random_uuid(), registration_number text not null unique, full_name text not null,
 department_id uuid references public.departments(id) on delete restrict, programme_id uuid references public.programmes(id) on delete restrict,
 cadre text, gender text check (gender is null or gender in ('female','male','other','prefer_not_to_say')),
 student_set text, admission_year integer, graduation_year integer, permanent_address text, phone_number text,
 college_uploaded boolean not null default true, imported_batch_id uuid, imported_at timestamptz not null default now(),
 profile_completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(graduation_year is null or admission_year is null or graduation_year >= admission_year)
);
create table public.clearance_sessions (
 id uuid primary key default gen_random_uuid(), name text not null, academic_session text,
 opens_at timestamptz, closes_at timestamptz, active boolean not null default false,
 created_at timestamptz not null default now(), created_by uuid references auth.users(id) on delete set null,
 check(closes_at is null or opens_at is null or closes_at > opens_at)
);
create unique index one_active_clearance_session on public.clearance_sessions(active) where active=true;
create table public.clearance_requirements (
 id uuid primary key default gen_random_uuid(), session_id uuid not null references public.clearance_sessions(id) on delete restrict,
 office_id uuid not null references public.clearance_offices(id) on delete restrict,
 department_id uuid references public.departments(id) on delete restrict,
 programme_id uuid references public.programmes(id) on delete restrict,
 required boolean not null default true, enabled boolean not null default true, instructions text,
 display_order integer not null default 100, created_at timestamptz not null default now(), created_by uuid references auth.users(id) on delete set null,
 unique nulls not distinct(session_id,office_id,department_id,programme_id)
);
create table public.session_students (
 id uuid primary key default gen_random_uuid(), session_id uuid not null references public.clearance_sessions(id) on delete restrict,
 student_id uuid not null references public.student_records(id) on delete restrict,
 payment_unlocked_at timestamptz, profile_confirmed_at timestamptz,
 final_assent public.final_assent_status not null default 'pending', final_assent_at timestamptz,
 final_assent_by uuid references auth.users(id) on delete set null, final_assent_remarks text,
 completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(session_id,student_id)
);
create table public.app_settings (
 setting_key text primary key, setting_value jsonb not null, description text,
 updated_at timestamptz not null default now(), updated_by uuid references auth.users(id) on delete set null
);
insert into public.app_settings(setting_key,setting_value,description) values
 ('clearance_fee_kobo','170000'::jsonb,'Clearance fee in kobo; 170000 = ₦1,700. SuperAdmin configurable.'),
 ('payment_currency','"NGN"'::jsonb,'Required payment currency.'),
 ('officer_reminder_interval_hours','24'::jsonb,'Reminder interval for unresolved clearance requests.') on conflict(setting_key) do nothing;
create table public.payment_transactions (
 id uuid primary key default gen_random_uuid(), session_student_id uuid not null references public.session_students(id) on delete restrict,
 provider text not null, provider_reference text not null unique, provider_transaction_id text,
 amount_kobo bigint not null check(amount_kobo>0), currency text not null default 'NGN' check(currency='NGN'),
 status public.payment_status not null default 'initiated', initiated_at timestamptz not null default now(), verified_at timestamptz,
 failure_reason text, provider_payload jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index payment_transactions_student_status_idx on public.payment_transactions(session_student_id,status);
create table public.clearance_requests (
 id uuid primary key default gen_random_uuid(), session_student_id uuid not null references public.session_students(id) on delete restrict,
 requirement_id uuid not null references public.clearance_requirements(id) on delete restrict,
 status public.clearance_status not null default 'not_requested', requested_at timestamptz, decision_at timestamptz,
 decided_by uuid references auth.users(id) on delete set null, last_reminded_at timestamptz,
 reminder_count integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(session_student_id,requirement_id)
);
create index clearance_requests_queue_idx on public.clearance_requests(requirement_id,status,requested_at);
create index clearance_requests_reminder_idx on public.clearance_requests(status,last_reminded_at) where status in ('requested','needs_attention');
create table public.clearance_comments (
 id uuid primary key default gen_random_uuid(), clearance_request_id uuid not null references public.clearance_requests(id) on delete restrict,
 author_user_id uuid references auth.users(id) on delete set null, author_role text not null,
 comment_text text not null check(length(trim(comment_text)) between 1 and 3000),
 visible_to_student boolean not null default true, created_at timestamptz not null default now()
);
create index clearance_comments_request_idx on public.clearance_comments(clearance_request_id,created_at);
create table public.audit_events (
 id bigint generated always as identity primary key, actor_user_id uuid references auth.users(id) on delete set null,
 actor_student_id uuid references public.student_records(id) on delete set null, event_type text not null,
 entity_type text not null, entity_id text, details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default now()
);
create index audit_events_entity_idx on public.audit_events(entity_type,entity_id,occurred_at desc);
create table public.notifications (
 id uuid primary key default gen_random_uuid(), recipient_user_id uuid references auth.users(id) on delete cascade,
 recipient_student_id uuid references public.student_records(id) on delete cascade,
 clearance_request_id uuid references public.clearance_requests(id) on delete cascade,
 channel text not null default 'in_app' check(channel in ('in_app','email')), notification_type text not null,
 title text not null, message text not null, scheduled_for timestamptz, sent_at timestamptz, read_at timestamptz,
 delivery_status text not null default 'queued' check(delivery_status in ('queued','sent','failed','cancelled')),
 created_at timestamptz not null default now(), check(recipient_user_id is not null or recipient_student_id is not null)
);
create index notifications_due_idx on public.notifications(scheduled_for,delivery_status);
create table public.certification_records (
 id uuid primary key default gen_random_uuid(), session_student_id uuid not null unique references public.session_students(id) on delete restrict,
 status public.certification_status not null default 'eligible', statement_reference text, certificate_reference text,
 assigned_to uuid references auth.users(id) on delete set null, processing_notes text, statement_ready_at timestamptz,
 certificate_ready_at timestamptz, completed_at timestamptz, updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.import_batches (
 id uuid primary key default gen_random_uuid(), original_filename text not null, uploaded_by uuid references auth.users(id) on delete set null,
 total_rows integer not null default 0, inserted_rows integer not null default 0, updated_rows integer not null default 0,
 rejected_rows integer not null default 0, status text not null default 'uploaded' check(status in ('uploaded','validating','ready','imported','failed')),
 error_report jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), completed_at timestamptz
);
alter table public.student_records add constraint student_records_import_batch_fk foreign key(imported_batch_id) references public.import_batches(id) on delete set null;

create or replace function public.has_role(required_role public.app_role)
returns boolean language sql stable security definer set search_path=public,auth as $$
 select exists(select 1 from public.staff_role_assignments sra where sra.user_id=auth.uid() and sra.role=required_role and sra.active=true);
$$;
create or replace function public.has_office_role(target_office_id uuid, allowed_roles public.app_role[])
returns boolean language sql stable security definer set search_path=public,auth as $$
 select exists(select 1 from public.staff_role_assignments sra where sra.user_id=auth.uid() and sra.office_id=target_office_id and sra.role=any(allowed_roles) and sra.active=true);
$$;
revoke all on function public.has_role(public.app_role) from public;
revoke all on function public.has_office_role(uuid,public.app_role[]) from public;
grant execute on function public.has_role(public.app_role) to authenticated;
grant execute on function public.has_office_role(uuid,public.app_role[]) to authenticated;

do $$ declare t text; begin foreach t in array array[
 'staff_profiles','departments','programmes','clearance_offices','staff_role_assignments','student_records','clearance_sessions',
 'clearance_requirements','session_students','app_settings','payment_transactions','clearance_requests','clearance_comments',
 'audit_events','notifications','certification_records','import_batches'] loop
 execute format('alter table public.%I enable row level security',t); end loop; end $$;
-- No permissive policies are intentionally included in this foundation migration.
commit;
