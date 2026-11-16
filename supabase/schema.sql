-- ============================================================
-- 막차알림: 실시간 위치 공유용 데이터베이스
-- Supabase 대시보드 → SQL Editor → 이 파일 내용 전체 붙여넣기 → Run
-- 여러 번 실행해도 안전합니다.
-- ============================================================

create extension if not exists pgcrypto;

-- 공유 1건 = 한 번의 귀가. 링크에 들어가는 id만 알면 위치를 볼 수 있고,
-- 위치를 바꾸거나 끝내려면 공유를 시작한 폰만 가진 owner_token이 필요합니다.
create table if not exists public.live_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_token uuid not null default gen_random_uuid(),
  lat         double precision,
  lng         double precision,
  accuracy    real,
  note        text,
  status      text not null default 'active' check (status in ('active', 'stopped', 'arrived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '6 hours'
);

-- 보안: 표에 직접 접근하는 정책을 만들지 않습니다.
-- → 앱은 다른 사람의 공유 목록을 조회할 수 없고, 아래 함수로만 접근합니다.
alter table public.live_shares enable row level security;
revoke all on public.live_shares from anon, authenticated;

-- 공유 시작: 새 공유를 만들고 id(링크용)와 owner_token(수정용)을 돌려줌
create or replace function public.create_share(p_lat double precision, p_lng double precision, p_note text default null)
returns table (id uuid, owner_token uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  -- 하루 넘게 지난 공유는 정리
  delete from live_shares where live_shares.expires_at < now() - interval '1 day';

  return query
    insert into live_shares (lat, lng, note)
    values (p_lat, p_lng, left(p_note, 300))
    returning live_shares.id, live_shares.owner_token, live_shares.expires_at;
end;
$$;

-- 위치 갱신: owner_token이 맞고 아직 진행 중인 공유만 바꿀 수 있음
create or replace function public.update_share(
  p_id uuid, p_token uuid, p_lat double precision, p_lng double precision,
  p_accuracy real default null, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update live_shares
     set lat = p_lat,
         lng = p_lng,
         accuracy = p_accuracy,
         note = coalesce(left(p_note, 300), note),
         updated_at = now()
   where id = p_id
     and owner_token = p_token
     and status = 'active'
     and expires_at > now();
  return found;
end;
$$;

-- 공유 끝내기: 'stopped'(직접 끔) 또는 'arrived'(집 도착)
create or replace function public.stop_share(p_id uuid, p_token uuid, p_status text default 'stopped')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('stopped', 'arrived') then
    p_status := 'stopped';
  end if;
  update live_shares
     set status = p_status, updated_at = now()
   where id = p_id and owner_token = p_token and status = 'active';
  return found;
end;
$$;

-- 친구가 보는 화면: id로 1건만 조회 (owner_token은 절대 돌려주지 않음)
create or replace function public.get_share(p_id uuid)
returns table (lat double precision, lng double precision, accuracy real, note text,
               status text, updated_at timestamptz, expires_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select s.lat, s.lng, s.accuracy, s.note,
         case when s.status = 'active' and s.expires_at <= now() then 'expired' else s.status end,
         s.updated_at, s.expires_at
    from live_shares s
   where s.id = p_id;
$$;

revoke all on function public.create_share(double precision, double precision, text) from public;
revoke all on function public.update_share(uuid, uuid, double precision, double precision, real, text) from public;
revoke all on function public.stop_share(uuid, uuid, text) from public;
revoke all on function public.get_share(uuid) from public;

grant execute on function public.create_share(double precision, double precision, text) to anon, authenticated;
grant execute on function public.update_share(uuid, uuid, double precision, double precision, real, text) to anon, authenticated;
grant execute on function public.stop_share(uuid, uuid, text) to anon, authenticated;
grant execute on function public.get_share(uuid) to anon, authenticated;
