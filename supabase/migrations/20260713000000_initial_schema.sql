-- Initial schema: enums + 8 tables, ported from the Google Sheets tabs.
-- See .claude/plan.md Section 8 for the design and Section 5.1 for the
-- old sheet -> table mapping.

create extension if not exists citext;

-- ENUMS
create type employee_type as enum ('Fixed', 'Probation');
create type emp_status    as enum ('Active', 'Inactive');
create type punch_action  as enum ('IN', 'OUT');
create type location_type as enum ('HEAD_OFFICE', 'WORKSHOP', 'WFH', 'OTHER');
create type leave_status  as enum ('Pending', 'Approved', 'Rejected');

-- LOCATIONS
create table locations (
  location_id   text primary key,
  location_name text not null,
  latitude      double precision not null,
  longitude     double precision not null,
  radius        int not null default 100
);

-- EMPLOYEES
create table employees (
  emp_id               text primary key,
  name                 text not null,
  email                citext unique not null,
  employee_type        employee_type not null default 'Fixed',
  assigned_location_id text references locations(location_id),
  shift_start_time     text default '09:30',
  status               emp_status not null default 'Active'
);

-- ADMINS (mirrors the old ADMIN sheet)
create table admins (
  email citext primary key
);

-- PUNCH_LOGS
create table punch_logs (
  log_id        bigint generated always as identity primary key,
  emp_id        text not null references employees(emp_id),
  action        punch_action not null,
  punched_at    timestamptz not null default now(),
  latitude      double precision,
  longitude     double precision,
  location_type location_type,
  location_name text
);
create index on punch_logs (emp_id, punched_at);

-- ATTENDANCE_SUMMARY (one row per employee per day)
create table attendance_summary (
  emp_id            text not null references employees(emp_id),
  date              date not null,
  in_time           time,
  out_time          time,
  status            text,
  late_flag         boolean not null default false,
  early_flag        boolean not null default false,
  half_day_flag     boolean not null default false,
  working_sunday    boolean not null default false,
  leave_credit_used numeric(3,1) not null default 0,
  notes             text,
  primary key (emp_id, date)
);

-- MONTHLY_SUMMARY (rollup, upserted on emp_id + month)
create table monthly_summary (
  emp_id                text not null references employees(emp_id),
  month                 text not null, -- 'yyyy-MM'
  working_days          int,
  total_present         int,
  total_late            int,
  total_early           int,
  total_half_days       int,
  total_absent          int,
  total_unpaid_absent   int,
  total_leaves_used     numeric(4,1),
  total_working_sundays int,
  late_early_used       int,
  leave_credits_used    numeric(4,1),
  primary key (emp_id, month)
);

-- LEAVE_REQUESTS
create table leave_requests (
  request_id   text primary key,
  emp_id       text not null references employees(emp_id),
  name         text,
  leave_from   date,
  leave_to     date,
  request_type text,
  reason       text,
  approved_by  text,
  proof_path   text, -- Supabase Storage path (replaces the old Drive share-link hack)
  status       leave_status not null default 'Pending',
  created_at   timestamptz not null default now(),
  admin_note   text
);

-- HOLIDAYS
create table holidays (
  date          date primary key,
  holiday_name  text not null
);
