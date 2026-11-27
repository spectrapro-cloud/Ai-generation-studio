-- Atomic, idempotent credit purchase and admin adjustment primitives.
create or replace function public.apply_credit_purchase(p_user_id uuid,p_credits integer,p_checkout_session_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_credits < 1 or p_credits > 100000 or length(p_checkout_session_id) < 5 then raise exception 'INVALID_PURCHASE'; end if;
  if exists(select 1 from public.credit_ledger where idempotency_key='stripe:'||p_checkout_session_id) then return; end if;
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  insert into public.credit_ledger(user_id,entry_type,amount,reason,idempotency_key)
  values(p_user_id,'purchase',p_credits,'stripe_checkout:'||p_checkout_session_id,'stripe:'||p_checkout_session_id)
  on conflict(idempotency_key) do nothing;
  if found then
    update public.profiles set credits=credits+p_credits,updated_at=now() where id=p_user_id;
  end if;
end; $$;

create or replace function public.admin_adjust_credits(p_admin_id uuid,p_user_id uuid,p_amount integer,p_reason text,p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_amount=0 or abs(p_amount)>100000 or length(trim(coalesce(p_reason,'')))<5 then raise exception 'INVALID_ADJUSTMENT'; end if;
  if not exists(select 1 from public.profiles where id=p_admin_id and role='admin') then raise exception 'ADMIN_REQUIRED'; end if;
  if exists(select 1 from public.credit_ledger where idempotency_key='admin:'||p_request_id) then return; end if;
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if (select credits+p_amount from public.profiles where id=p_user_id)<0 then raise exception 'INSUFFICIENT_CREDITS'; end if;
  insert into public.credit_ledger(user_id,entry_type,amount,reason,idempotency_key)
  values(p_user_id,'admin_adjustment',p_amount,'admin:'||p_admin_id::text||' - '||trim(p_reason),'admin:'||p_request_id)
  on conflict(idempotency_key) do nothing;
  if found then update public.profiles set credits=credits+p_amount,updated_at=now() where id=p_user_id; end if;
end; $$;

revoke all on function public.apply_credit_purchase(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.admin_adjust_credits(uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.apply_credit_purchase(uuid,integer,text) to service_role;
grant execute on function public.admin_adjust_credits(uuid,uuid,integer,text,text) to service_role;
