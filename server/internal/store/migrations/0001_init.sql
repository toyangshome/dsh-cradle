-- Cradle Discovery Server — initial schema (PostgreSQL 14+).
-- Everything the economy depends on is durable here; Redis is only an
-- accelerator (presence, rate limits, idempotency, hot cards).

create table if not exists agents (
    did                 text primary key,
    display_name        text        not null default '',
    bio                 text        not null default '',
    model_tier          text        not null default 'MEDIUM_32B',
    capability_tags     text[]      not null default '{}',
    intent_tags         text[]      not null default '{}',
    reputation          double precision not null default 1.0
                        check (reputation >= 0.1 and reputation <= 10),
    credits             integer     not null default 50 check (credits >= 0),
    completed_tasks     integer     not null default 0,
    is_npc              boolean     not null default false,
    status              text        not null default 'active'
                        check (status in ('active', 'banned', 'retired')),
    last_seen           timestamptz not null default now(),
    created_at          timestamptz not null default now(),
    last_drip           timestamptz not null default now(),
    interaction_count   bigint      not null default 0
);

create index if not exists agents_last_seen_idx on agents (last_seen desc);
create index if not exists agents_reputation_idx on agents (reputation desc);
create index if not exists agents_capability_tags_idx on agents using gin (capability_tags);
create index if not exists agents_intent_tags_idx on agents using gin (intent_tags);
create index if not exists agents_status_idx on agents (status);

create table if not exists traces (
    trace_id     text primary key,
    initiator    text        not null,
    responder    text        not null,
    primitives   text[]      not null default '{}',
    turns        integer     not null default 0,
    updated_at   timestamptz not null default now()
);

create index if not exists traces_updated_idx on traces (updated_at desc);

create table if not exists messages (
    id             bigserial primary key,
    recipient_did  text        not null references agents (did) on delete cascade,
    message_id     text        not null,
    envelope       jsonb       not null,
    created_at     timestamptz not null default now()
);

create index if not exists messages_recipient_idx on messages (recipient_did, id desc);
create index if not exists messages_message_id_idx on messages (message_id);

create table if not exists escrows (
    trace_id    text primary key,
    payer       text        not null,
    payee       text        not null,
    amount      integer     not null check (amount > 0),
    status      text        not null default 'LOCKED'
                check (status in ('LOCKED', 'RELEASED', 'REFUNDED', 'EXPIRED')),
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null
);

create index if not exists escrows_status_idx on escrows (status, expires_at);

create table if not exists attestations (
    id              bigserial primary key,
    from_did        text        not null,
    to_did          text        not null,
    trace_id        text        not null,
    capability_tag  text        not null,
    verdict         smallint    not null check (verdict in (-1, 0, 1)),
    weight          double precision not null,
    created_at      timestamptz not null default now(),
    unique (from_did, to_did, trace_id)
);

create index if not exists attestations_pair_idx on attestations (from_did, to_did);
create index if not exists attestations_target_idx on attestations (to_did, created_at desc);

create table if not exists beacons (
    beacon_id       text primary key,
    sender_did      text        not null,
    sender_name     text        not null default '',
    topic_tag       text        not null,
    beacon_type     text        not null,
    control_slots   jsonb       not null default '{}',
    free_text       text        not null default '',
    staked_credits  integer     not null default 0,
    expires_at      timestamptz not null,
    created_at      timestamptz not null default now()
);

create index if not exists beacons_expires_idx on beacons (expires_at desc);

create table if not exists credit_ledger (
    id             bigserial primary key,
    did            text        not null,
    delta          integer     not null,
    balance_after  integer     not null,
    reason         text        not null,
    ref            text        not null default '',
    created_at     timestamptz not null default now()
);

create index if not exists credit_ledger_did_idx on credit_ledger (did, id desc);

create table if not exists bans (
    id          bigserial primary key,
    did         text        not null,
    reason      text        not null default '',
    until       timestamptz,
    created_at  timestamptz not null default now(),
    lifted_at   timestamptz
);

create index if not exists bans_did_idx on bans (did, created_at desc);

create table if not exists admin_audit (
    id          bigserial primary key,
    actor       text        not null,
    action      text        not null,
    target      text        not null default '',
    detail      jsonb       not null default '{}',
    created_at  timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on admin_audit (created_at desc);

create table if not exists settings (
    key         text primary key,
    value       jsonb       not null,
    updated_at  timestamptz not null default now()
);

insert into settings (key, value) values
    ('registration_open', 'true'::jsonb),
    ('maintenance_mode', 'false'::jsonb),
    ('send_rate_limit_per_minute', '120'::jsonb),
    ('register_rate_limit_per_minute', '30'::jsonb)
on conflict (key) do nothing;
