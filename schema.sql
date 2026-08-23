-- ============================================================================
-- Dombi Riders — Вътрешна система за управление
-- Схема на базата данни (PostgreSQL / Supabase)
-- ============================================================================
-- Изпълнява се в Supabase SQL Editor (или през MCP execute_sql) след като
-- проектът е създаден. Използва вградената auth.users таблица на Supabase
-- за автентикация; profiles разширява всеки потребител с роля и данни.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- РОЛИ И ПОТРЕБИТЕЛИ
-- ---------------------------------------------------------------------------
create type user_role as enum ('admin', 'manager', 'driver');
create type user_status as enum ('active', 'invited', 'suspended');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role user_role not null default 'driver',
  status user_status not null default 'invited',
  -- финоструена права в допълнение към ролята (админ решава какво могат другите)
  -- напр. {"can_approve_transfers": true} — позволява на не-админ да одобрява
  -- преводи между портфейли (виж WALLETS по-долу)
  permissions jsonb not null default '{}'::jsonb,
  avatar_url text,

  -- йерархия: към кой мениджър е прикрепен шофьорът (мениджърите могат
  -- едновременно да бъдат и активни шофьори — виж driver_manager_id по-долу
  -- само определя "докладва на", не изключва role='driver' за самия мениджър)
  manager_id uuid references profiles(id),

  -- лична карта / шофьорска книжка — за досието и алармите за изтичане
  -- (id_card_photo_url/driver_license_photo_url пазят лицевата страна за
  -- обратна съвместимост с /api/hr/personnel/:id/id-photo|license-photo;
  -- гърбовете и селфито се попълват само при одобрение на кандидатура)
  egn text,
  address text,
  id_card_number text,
  id_card_expiry date,
  id_card_photo_url text,
  id_card_photo_back_url text,
  selfie_photo_url text,
  driver_license_number text,
  driver_license_expiry date,
  driver_license_photo_url text,
  driver_license_photo_back_url text,

  -- пренесени от кандидатурата при одобрение (виж job_applications по-долу)
  had_glovo_bolt_account text,          -- 'yes' | 'no'
  glovo_bolt_platform text,
  city text,
  work_vehicle_type text,
  nationality text,
  nationality_other text,
  protection_status_photo_url text,
  residence_permit_photo_url text,
  nap_certificate_photo_url text,

  -- външни идентификатори от Bolt/Glovo (за съпоставяне при импорт на
  -- заработки — виж payroll_entries.platform_breakdown и lib/earnings-import.js
  -- в Node бекенда) — {"glovo_courier_id": "G...", "bolt_courier_uid": "U..."}
  external_ids jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table profiles is 'Служители/потребители на системата: админ, мениджър, шофьор (куриер)';
create index idx_profiles_manager on profiles(manager_id);

-- ---------------------------------------------------------------------------
-- АВТОПАРК: КОЛИ
-- ---------------------------------------------------------------------------
create type vehicle_status as enum ('available', 'assigned', 'rented', 'in_service', 'inactive');
create type fuel_type as enum ('petrol', 'diesel', 'hybrid', 'electric', 'lpg');
create type transmission_type as enum ('manual', 'automatic');
create type vehicle_category as enum ('economy', 'comfort', 'hybrid_electric', 'moto', 'scooter', 'bike');

create table vehicles (
  id uuid primary key default uuid_generate_v4(),
  plate_number text not null unique,
  vin text unique,
  make text not null,
  model text not null,
  year int,
  color text,
  category vehicle_category not null default 'economy',
  fuel fuel_type,
  transmission transmission_type,
  seats int,
  status vehicle_status not null default 'available',

  -- себестойност / финансови данни
  purchase_price numeric(12,2),
  purchase_date date,
  depreciation_months int default 60,          -- линейна амортизация по подразбиране 5г
  residual_value numeric(12,2) default 0,

  -- документи / срокове
  registration_expiry date,
  vignette_expiry date,
  inspection_expiry date,                       -- годишен технически преглед

  -- гражданска отговорност (задължителна застраховка)
  insurance_expiry date,
  insurance_insurer text,
  insurance_policy_number text,

  -- каско (доброволна застраховка)
  casco_expiry date,
  casco_insurer text,
  casco_policy_number text,

  -- данни от талона (снети ръчно или разчетени от снимка с AI)
  talon_photo_url text,
  talon_data jsonb default '{}'::jsonb,
  talon_confirmed boolean default false,

  -- пробег и сервизни интервали (виж таблица odometer_logs за пълна история)
  initial_odometer_km int default 0,             -- пробег при въвеждане в системата
  service_interval_km int default 10000,          -- на колко км се очаква следващ сервиз (общ, тип "other")
  service_interval_months int default 6,           -- или на колко месеца — което дойде първо

  -- отделни интервали за масло и ангренажен (ГРМ) ремък — проследяват се
  -- самостоятелно от общия сервизен интервал, защото периодите им са много
  -- по-различни (масло: чести смени; ГРМ: рядко, но критично при просрочване)
  oil_interval_km int default 10000,
  oil_interval_months int default 12,
  timing_belt_interval_km int default 90000,
  timing_belt_interval_months int default 60,

  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table vehicles is 'Автомобили в автопарка на Dombi Riders';

create table vehicle_equipment (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  name text not null,               -- напр. GPS тракер, термо чанта, детско столче
  serial_number text,
  quantity int default 1,
  added_at date default current_date,
  notes text
);
comment on table vehicle_equipment is 'Оборудване, монтирано/придружаващо всяка кола';

-- ---------------------------------------------------------------------------
-- СЕРВИЗНА КНИЖКА И РАЗХОДИ
-- ---------------------------------------------------------------------------
create type service_type as enum ('maintenance', 'repair', 'inspection', 'tires', 'wash', 'oil_change', 'timing_belt', 'other');

create table service_records (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  service_date date not null default current_date,
  odometer_km int,
  type service_type not null default 'maintenance',
  description text not null,
  vendor text,
  cost numeric(12,2) not null default 0,
  next_due_km int,
  next_due_date date,
  attachments jsonb default '[]'::jsonb,        -- масив от URL-и към фактури/снимки
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
comment on table service_records is 'Сервизна книжка — всеки ремонт/поддръжка на кола';

create type cost_type as enum ('insurance_civil', 'insurance_casco', 'vignette', 'tax', 'parking', 'fine', 'other_recurring');

create table vehicle_recurring_costs (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  type cost_type not null,
  amount numeric(12,2) not null,
  period_start date not null,
  period_end date,
  notes text,
  created_at timestamptz not null default now()
);
comment on table vehicle_recurring_costs is 'Периодични разходи по кола: застраховка, винетка, данък и др.';

-- ---------------------------------------------------------------------------
-- ЗАДЪЛЖИТЕЛЕН МЕСЕЧЕН ПРЕГЛЕД: външно + вътрешно + техническо състояние,
-- всеки запис е обвързан с отговорник (inspector_id), който е извършил
-- прегледа. Един запис на кола на календарен месец (month, формат YYYY-MM) —
-- dashboard-ът маркира като просрочена всяка кола без запис за текущия месец.
-- ---------------------------------------------------------------------------
create type inspection_check_result as enum ('ok', 'issue');

create table vehicle_inspections (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  month text not null,                            -- 'YYYY-MM' — календарният месец, за който важи прегледът
  inspection_date date not null default current_date,
  inspector_id uuid not null references profiles(id),   -- отговорник, извършил прегледа

  exterior_result inspection_check_result not null default 'ok',
  exterior_notes text,
  interior_result inspection_check_result not null default 'ok',
  interior_notes text,
  technical_result inspection_check_result not null default 'ok',
  technical_notes text,

  photos jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),

  unique (vehicle_id, month)
);
comment on table vehicle_inspections is 'Задължителен месечен чек лист (външно/вътрешно/техническо състояние) с отговорник';

-- ---------------------------------------------------------------------------
-- ПРОБЕГ: пълна история на всички отчетени показания на километража,
-- независимо дали идват от протокол, зачисляване, сервиз, договор или
-- ръчно въвеждане. "Текущ пробег" на колата = най-високата стойност тук.
-- ---------------------------------------------------------------------------
create type odometer_source as enum ('manual', 'protocol', 'service', 'assignment', 'contract');

create table odometer_logs (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  km int not null,
  source odometer_source not null default 'manual',
  source_id uuid,                                 -- id на протокола/сервиза/... (ако е приложимо)
  note text,
  recorded_by uuid references profiles(id),
  recorded_at timestamptz not null default now()
);
comment on table odometer_logs is 'Пълна история на показанията на километража на всяка кола';
create index idx_odometer_logs_vehicle on odometer_logs(vehicle_id);

-- ---------------------------------------------------------------------------
-- ЗАЧИСЛЯВАНЕ НА ШОФЬОРИ (ВЪТРЕШНИ ОТ HR ИЛИ ВЪНШНИ)
-- ---------------------------------------------------------------------------
create type assignment_purpose as enum ('dombi_courier', 'other_platform', 'personal_use');
create type assignment_status as enum ('active', 'ended');

create table vehicle_assignments (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,

  -- вътрешен шофьор (от HR модула — profiles с роля driver) ИЛИ външно лице
  driver_id uuid references profiles(id),
  external_name text,
  external_phone text,
  external_egn text,
  external_license_number text,

  purpose assignment_purpose not null default 'dombi_courier',
  status assignment_status not null default 'active',
  start_date date not null default current_date,
  end_date date,
  start_odometer_km int,
  end_odometer_km int,
  notes text,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),

  constraint driver_or_external check (
    (driver_id is not null and external_name is null)
    or (driver_id is null and external_name is not null)
  )
);
comment on table vehicle_assignments is 'История на зачисления: кой кара коя кола, кога и с каква цел';

-- ---------------------------------------------------------------------------
-- ПРИЕМО-ПРЕДАВАТЕЛНИ ПРОТОКОЛИ (СЪС СНИМКИ)
-- ---------------------------------------------------------------------------
create type protocol_type as enum ('handover', 'return');   -- предаване / приемане обратно
create type signature_status as enum ('none', 'signed_in_person', 'sent_remote', 'signed_remote', 'declined');
create type signature_method as enum ('in_person', 'remote');

create table handover_protocols (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  assignment_id uuid references vehicle_assignments(id),
  type protocol_type not null,
  protocol_number text unique,                  -- напр. HP-2026-000123
  date timestamptz not null default now(),
  odometer_km int,
  fuel_type text,                               -- petrol | diesel | gas_petrol | electric | hybrid
  fuel_level_pct int,                           -- ниво на основното гориво в %
  fuel_level_secondary_pct int,                 -- ниво на допълнителното гориво в % (само при fuel_type='gas_petrol' — газов инсталация)
  exterior_notes text,
  interior_notes text,
  damages jsonb default '[]'::jsonb,             -- [{x,y,description}] точки върху схема на колата
  driver_signature_url text,
  manager_signature_url text,
  pdf_url text,

  -- електронно разписване (виж esign_events за одиторски запис)
  signature_status signature_status not null default 'none',
  signature_method signature_method,
  signed_at timestamptz,
  signed_by_name text,
  esign_provider text,                          -- напр. 'signnow', 'in_house'
  esign_envelope_id text,                       -- id при външен доставчик

  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
comment on table handover_protocols is 'Протокол при предаване/приемане на кола, с прикачени снимки';

create table handover_protocol_photos (
  id uuid primary key default uuid_generate_v4(),
  protocol_id uuid not null references handover_protocols(id) on delete cascade,
  photo_url text not null,
  caption text,
  position int default 0
);

-- ---------------------------------------------------------------------------
-- ДОГОВОРИ ЗА НАЕМ
-- ---------------------------------------------------------------------------
create type contract_status as enum ('draft', 'active', 'completed', 'terminated');

create table rental_contracts (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  assignment_id uuid references vehicle_assignments(id),
  contract_number text unique not null,

  renter_type assignment_purpose not null default 'dombi_courier',
  renter_driver_id uuid references profiles(id),
  renter_name text,
  renter_egn text,
  renter_phone text,
  renter_email text,
  renter_address text,
  renter_license_number text,

  start_date date not null,
  end_date date,
  rate_amount numeric(12,2) not null,
  rate_period text not null default 'week',      -- week | month | day
  deposit_amount numeric(12,2) default 0,
  start_odometer_km int,
  end_odometer_km int,

  status contract_status not null default 'draft',
  pdf_url text,

  -- електронно разписване (виж esign_events за одиторски запис)
  signature_status signature_status not null default 'none',
  signature_method signature_method,
  signed_at timestamptz,
  signed_by_name text,
  esign_provider text,
  esign_envelope_id text,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table rental_contracts is 'Договори за наем на автомобил (куриери и външни лица)';

-- ---------------------------------------------------------------------------
-- ЕЛЕКТРОННО РАЗПИСВАНЕ: одиторски запис за всеки подпис (присъствен през
-- вградения модул, или отдалечен през външен доставчик като SignNow).
-- Пази хеш на съдържанието към момента на подписване, за да е доказуемо
-- че документът не е променян след подписа.
-- ---------------------------------------------------------------------------
create table esign_events (
  id uuid primary key default uuid_generate_v4(),
  document_type text not null,                  -- 'protocol' | 'contract'
  document_id uuid not null,
  method signature_method not null,
  provider text not null default 'in_house',      -- 'in_house' | 'signnow' | 'docusign'
  signer_name text,
  signer_role text,                              -- напр. 'driver', 'renter', 'manager'
  signature_image_url text,                       -- за присъствен подпис (canvas -> PNG)
  document_hash text,                             -- SHA-256 на съдържанието при подписване
  ip_address text,
  user_agent text,
  status text not null default 'pending',          -- pending | completed | declined
  external_envelope_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
comment on table esign_events is 'Одиторски запис на всеки опит/успешен подпис на протокол или договор';
create index idx_esign_events_document on esign_events(document_type, document_id);

-- ---------------------------------------------------------------------------
-- РЕДАКТИРУЕМИ ШАБЛОНИ НА БЛАНКИ (протокол, договор) — текстът се пази тук и
-- се обединява с реалните данни при генериране/печат на документа. Може да
-- се замени и с качен .docx шаблон (file_url) — виж README за детайли.
-- ---------------------------------------------------------------------------
create table document_templates (
  id uuid primary key default uuid_generate_v4(),
  doc_type text not null unique,                  -- 'protocol' | 'contract'
  source text not null default 'builtin',          -- 'builtin' | 'docx'
  content text,                                    -- текст с {{плейсхолдъри}} (builtin)
  file_url text,                                   -- качен .docx шаблон (source = 'docx')
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);
comment on table document_templates is 'Редактируеми шаблони за печатните бланки (протокол/договор)';

-- ---------------------------------------------------------------------------
-- ПЛАЩАНИЯ (приходи от наем / разходи) — база за статистика "печалба"
-- ---------------------------------------------------------------------------
create type payment_direction as enum ('income', 'expense');

create table vehicle_payments (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  contract_id uuid references rental_contracts(id),
  direction payment_direction not null,
  amount numeric(12,2) not null,
  payment_date date not null default current_date,
  description text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
comment on table vehicle_payments is 'Постъпления (наем) и разходи по кола — база за таблото за печалба';

-- ============================================================================
-- HR МОДУЛ
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ПОРТФЕЙЛИ: вътрешна счетоводна книга (само в системата — НЕ истински
-- банкови/платежни преводи). Балансът на всеки потребител = сума от
-- wallet_transactions.amount за него; не се пази отделно поле "balance", за
-- да няма как да се разсинхронизира. Всеки превод минава първо като заявка
-- (wallet_transfers, status='pending') и произвежда двете вписвания в
-- wallet_transactions едва след одобрение.
-- ---------------------------------------------------------------------------
create type wallet_transfer_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type wallet_transaction_type as enum ('transfer', 'admin_adjustment', 'payroll_payout', 'commission_payout');

create table wallet_transfers (
  id uuid primary key default uuid_generate_v4(),
  from_user_id uuid not null references profiles(id),
  to_user_id uuid not null references profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  status wallet_transfer_status not null default 'pending',
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,
  constraint transfer_not_to_self check (from_user_id <> to_user_id)
);
comment on table wallet_transfers is 'Заявки за превод между портфейли — одобрява админ (или делегиран потребител)';

create table wallet_transactions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references profiles(id),
  amount numeric(12,2) not null,              -- положително = заверка, отрицателно = задължаване
  type wallet_transaction_type not null default 'admin_adjustment',
  related_transfer_id uuid references wallet_transfers(id),
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
comment on table wallet_transactions is 'Пълна история на движенията по всеки портфейл (балансът се смята от тук)';
create index idx_wallet_tx_user on wallet_transactions(user_id);
create index idx_wallet_transfers_users on wallet_transfers(from_user_id, to_user_id);

create or replace view wallet_balances as
select user_id, coalesce(sum(amount), 0) as balance
from wallet_transactions
group by user_id;

-- ---------------------------------------------------------------------------
-- ОТПУСКИ (годишен платен / болничен / неплатен) — виж README за резюме на
-- изискванията по КТ, използвани като разумни подразбиращи се стойности.
-- ---------------------------------------------------------------------------
create type leave_type as enum ('annual', 'sick', 'unpaid', 'other');
create type leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');

create table leave_balances (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references profiles(id) on delete cascade,
  year int not null,
  entitled_days numeric(5,2) not null default 20,   -- пропорционално на % заетост при непълно работно време
  carried_over_days numeric(5,2) not null default 0,
  notes text,
  unique (profile_id, year)
);
comment on table leave_balances is 'Годишен баланс на дните платен отпуск за всеки служител';

create table leave_requests (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references profiles(id) on delete cascade,
  type leave_type not null default 'annual',
  start_date date not null,
  end_date date not null,
  days numeric(5,2) not null,
  status leave_status not null default 'pending',
  note text,
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,
  constraint leave_dates_valid check (end_date >= start_date)
);
comment on table leave_requests is 'Заявки за отпуск — одобрява прекият мениджър или админ';
create index idx_leave_requests_profile on leave_requests(profile_id);

-- ---------------------------------------------------------------------------
-- ТРУДОВИ/ГРАЖДАНСКИ ДОГОВОРИ (HR) — отделно от rental_contracts (наем на
-- кола). hours_per_day се ползва само за трудов договор (2/4/6/8ч);
-- граждански договор няма фиксирани часове. Разписването минава през същия
-- esign_events механизъм като протоколите/договорите за наем на кола.
-- ⚠️ Истински трудов договор по КТ изисква КЕП от работодателя за
-- ЕЛЕКТРОННО подписване — виж README. Присъственият SES подпис тук е
-- временно/резервно решение, не заместител на КЕП за трудови договори.
-- ---------------------------------------------------------------------------
create type employment_contract_type as enum ('labor', 'civil');
create type employment_contract_status as enum ('draft', 'active', 'terminated');

create table employment_contracts (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references profiles(id) on delete cascade,
  contract_type employment_contract_type not null,
  hours_per_day int,                                -- 2 | 4 | 6 | 8, само за 'labor'
  contract_number text unique,
  start_date date not null,
  end_date date,
  weekly_deduction_amount numeric(12,2) not null default 0,   -- по подразбиране от тип, ръчно променимо
  status employment_contract_status not null default 'draft',

  signature_status signature_status not null default 'none',
  signature_method signature_method,
  signed_at timestamptz,
  signed_by_name text,
  esign_provider text,
  esign_envelope_id text,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint labor_has_hours check (contract_type <> 'labor' or hours_per_day is not null)
);
comment on table employment_contracts is 'Трудови (по часови пояси) и граждански договори на служителите';
create index idx_employment_contracts_profile on employment_contracts(profile_id);

-- ---------------------------------------------------------------------------
-- САМОКАНДИДАТСТВАНЕ: публична форма (без вход) за нови кандидат-шофьори —
-- качват лични данни + снимки на документи, AI ги разчита автоматично.
-- Одобрение от админ/мениджър превръща записа в profiles + employment_contracts.
-- ---------------------------------------------------------------------------
-- 'link_sent'/'details_completed' обслужват двуетапния процес: кратка форма
-- (маркетинг сайт: само име/телефон/имейл) → админ генерира линк с 1 клик
-- (application_token) → кандидатът допълва ЛК/книжка/ЕГН/избор на договор на
-- /apply-details.html?token=... върху СЪЩИЯ запис (виж lib/db.js
-- generateApplicationLink/completeApplicationDetails).
create type application_status as enum ('pending', 'link_sent', 'details_completed', 'approved', 'rejected');

-- 'city' валидни стойности: sofia | plovdiv | varna | burgas
-- 'work_vehicle_type' (с какво ще кара) валидни стойности: own_car | company_car | bicycle | scooter
--   — различно от евентуален по-широк избор на превозно средство в маркетинг
--   сайта (какво ПРИТЕЖАВА кандидатът); това поле е конкретно за работата.
-- 'nationality' валидни стойности: bulgarian | ukrainian | uzbek | other
--   (nationality_other се попълва само при 'other'). Документи за чужди
--   граждани (виж по-долу) се изискват само когато nationality <> 'bulgarian':
--     ukrainian        → protection_status_photo_url ("Закрила")
--     uzbek / other    → residence_permit_photo_url (разрешение за пребиваване)
--                        + nap_certificate_photo_url (удостоверение от НАП за работа)
create table job_applications (
  id uuid primary key default uuid_generate_v4(),
  full_name text not null,
  egn text,
  phone text,
  email text,
  address text,
  id_card_number text,
  id_card_expiry date,
  id_card_photo_front_url text,
  id_card_photo_back_url text,
  selfie_photo_url text,
  driver_license_number text,
  driver_license_expiry date,
  driver_license_photo_front_url text,
  driver_license_photo_back_url text,
  desired_contract_type employment_contract_type not null default 'labor',
  desired_hours_per_day int,
  notes text,
  had_glovo_bolt_account text,          -- 'yes' | 'no'
  glovo_bolt_platform text,             -- свободен текст: Glovo / Bolt / и двете
  city text,                            -- виж валидни стойности по-горе
  work_vehicle_type text,               -- виж валидни стойности по-горе
  nationality text,                     -- виж валидни стойности по-горе
  nationality_other text,
  protection_status_photo_url text,     -- "Закрила" (украински граждани)
  residence_permit_photo_url text,      -- разрешение за пребиваване (др. чужди граждани)
  nap_certificate_photo_url text,       -- удостоверение от НАП за работа (др. чужди граждани)
  status application_status not null default 'pending',
  application_token text unique,       -- линк за довършване от кандидата (виж коментара по-горе)
  token_created_at timestamptz,
  details_completed_at timestamptz,
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  created_profile_id uuid references profiles(id),   -- попълва се при одобрение
  created_at timestamptz not null default now()
);
comment on table job_applications is 'Входящи кандидатури от публичната форма за самокандидатстване';

-- ---------------------------------------------------------------------------
-- СЕДМИЧНИ ЗАПЛАТИ: брой поръчки + заработка за периода (внесени ръчно от
-- таблица, докато няма пряка интеграция с Glovo/Bolt). Разписването на
-- шофьора потвърждава САМО броя поръчки — НЕ сумата (изрично изискване) —
-- затова esign хешът се смята върху документ, съдържащ само брой + седмица.
-- ---------------------------------------------------------------------------
create table payroll_entries (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  order_count int not null default 0,
  gross_earnings numeric(12,2) not null default 0,
  deduction_amount numeric(12,2) not null default 0,   -- по подразбиране от employment_contracts, ръчно променимо
  net_amount numeric(12,2) generated always as (gross_earnings - deduction_amount) stored,
  source text not null default 'manual',                -- 'manual' | 'bolt' | 'glovo' | 'bolt+glovo'
  paid boolean not null default false,
  paid_at timestamptz,

  -- при внос от Bolt/Glovo — разбивка по платформа, напр. {"bolt": 7.63, "glovo": 1032.97}
  -- (виж POST /api/hr/payroll/import/apply и lib/earnings-import.js)
  platform_breakdown jsonb not null default '{}'::jsonb,
  -- вдигнат при повредена/нечислова клетка в оригиналния Excel файл (наблюдавано
  -- реално в Glovo експорти) — сумата за реда е частична, изисква ръчна проверка
  needs_review boolean not null default false,
  -- Bolt експортът не съдържа брой поръчки — вдигнат, когато order_count не
  -- идва от реални данни за тази платформа
  order_count_unknown boolean not null default false,
  -- път към архивирания оригинален .xlsx файл (за одит), ако е качен през UI
  import_file text,
  note text,

  -- потвърждение на шофьора — само за броя поръчки (виж esign_events)
  signature_status signature_status not null default 'none',
  signed_at timestamptz,
  signed_by_name text,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (profile_id, week_start)
);
comment on table payroll_entries is 'Седмична заработка по шофьор — внесена ръчно, потвърждава се от шофьора (само брой поръчки)';
create index idx_payroll_profile on payroll_entries(profile_id, week_start);

-- ---------------------------------------------------------------------------
-- РЕФЕРАЛНИ/ПОСРЕДНИЧЕСКИ ПАРТНЬОРИ: обвързани към потребител с роля
-- 'manager' (мениджърите могат едновременно да бъдат и активни шофьори).
-- comp_base се пази като свободен текст, докато не се финализира точната
-- формула с реални данни — виж README.
-- ---------------------------------------------------------------------------
create type commission_type as enum ('percentage', 'fixed');
create type commission_period as enum ('week', 'month');

create table partner_commission_profiles (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null unique references profiles(id) on delete cascade,
  comp_type commission_type not null default 'percentage',
  percentage numeric(5,2),                              -- ако comp_type = 'percentage'
  fixed_amount numeric(12,2),                            -- ако comp_type = 'fixed'
  fixed_period commission_period default 'month',
  comp_base text default 'net_revenue_after_platform_fee',  -- виж README — подлежи на потвърждение
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table partner_commission_profiles is 'Комисионна на реферални/посреднически партньори (мениджъри) — % или фиксирана сума';

-- ---------------------------------------------------------------------------
-- СЧЕТОВОДСТВО: ръчна счетоводна книга — приходи/разходи, които нямат друго
-- специализирано място в системата (наем офис, комунални, реклама, заплати
-- на офис персонал и т.н.). Общият финансов отчет (виж GET /api/finance/report
-- в server.js) комбинира тези записи с приходите от наем на коли
-- (vehicle_payments), седмичните такси от шофьорите (payroll_entries.
-- deduction_amount — РЕАЛНИЯТ приход на фирмата от шофьор, не gross_earnings),
-- разходите по автопарка (service_records + vehicle_recurring_costs) и
-- изчислените партньорски комисионни (partner_commission_profiles).
-- ---------------------------------------------------------------------------
create type finance_direction as enum ('income', 'expense');

create table finance_entries (
  id uuid primary key default uuid_generate_v4(),
  entry_date date not null,
  direction finance_direction not null,
  category text not null,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
comment on table finance_entries is 'Ръчна счетоводна книга за приходи/разходи извън автоматично изчислените пера';
create index idx_finance_entries_date on finance_entries(entry_date);

-- ---------------------------------------------------------------------------
-- ИНДЕКСИ
-- ---------------------------------------------------------------------------
create index idx_service_records_vehicle on service_records(vehicle_id);
create index idx_assignments_vehicle on vehicle_assignments(vehicle_id);
create index idx_assignments_driver on vehicle_assignments(driver_id);
create index idx_protocols_vehicle on handover_protocols(vehicle_id);
create index idx_contracts_vehicle on rental_contracts(vehicle_id);
create index idx_payments_vehicle on vehicle_payments(vehicle_id);
create index idx_recurring_costs_vehicle on vehicle_recurring_costs(vehicle_id);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY (роли: admin вижда/прави всичко; manager — оперативно;
-- driver — само собствените си зачисления/протоколи)
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
alter table vehicles enable row level security;
alter table vehicle_equipment enable row level security;
alter table service_records enable row level security;
alter table vehicle_recurring_costs enable row level security;
alter table vehicle_assignments enable row level security;
alter table handover_protocols enable row level security;
alter table handover_protocol_photos enable row level security;
alter table rental_contracts enable row level security;
alter table vehicle_payments enable row level security;

create or replace function current_role_name() returns user_role
language sql stable as $$
  select role from profiles where id = auth.uid()
$$;

-- profiles: всеки вижда себе си; admin/manager виждат всички
create policy profiles_select on profiles for select
  using (id = auth.uid() or current_role_name() in ('admin','manager'));
create policy profiles_update_self on profiles for update
  using (id = auth.uid() or current_role_name() = 'admin');
create policy profiles_insert_admin on profiles for insert
  with check (current_role_name() = 'admin');

-- vehicles/фактически fleet данни: admin+manager пълен достъп, driver само четене
create policy vehicles_all_staff on vehicles for select using (true);
create policy vehicles_write_admin_manager on vehicles for insert with check (current_role_name() in ('admin','manager'));
create policy vehicles_update_admin_manager on vehicles for update using (current_role_name() in ('admin','manager'));
create policy vehicles_delete_admin on vehicles for delete using (current_role_name() = 'admin');

-- по подобие: equipment/service/costs/contracts — admin+manager пишат, всички четат
create policy equipment_select on vehicle_equipment for select using (true);
create policy equipment_write on vehicle_equipment for insert with check (current_role_name() in ('admin','manager'));
create policy equipment_update on vehicle_equipment for update using (current_role_name() in ('admin','manager'));

create policy service_select on service_records for select using (true);
create policy service_write on service_records for insert with check (current_role_name() in ('admin','manager'));

create policy costs_select on vehicle_recurring_costs for select using (current_role_name() in ('admin','manager'));
create policy costs_write on vehicle_recurring_costs for insert with check (current_role_name() in ('admin','manager'));

-- assignments: driver вижда само своите; admin/manager всички
create policy assignments_select on vehicle_assignments for select
  using (driver_id = auth.uid() or current_role_name() in ('admin','manager'));
create policy assignments_write on vehicle_assignments for insert
  with check (current_role_name() in ('admin','manager'));
create policy assignments_update on vehicle_assignments for update
  using (current_role_name() in ('admin','manager'));

-- protocols: driver вижда/подписва своите; admin/manager всички
create policy protocols_select on handover_protocols for select
  using (
    current_role_name() in ('admin','manager')
    or exists (select 1 from vehicle_assignments a where a.id = assignment_id and a.driver_id = auth.uid())
  );
create policy protocols_write on handover_protocols for insert with check (current_role_name() in ('admin','manager'));
create policy protocol_photos_select on handover_protocol_photos for select using (true);
create policy protocol_photos_write on handover_protocol_photos for insert with check (current_role_name() in ('admin','manager'));

-- contracts/payments: само admin+manager
create policy contracts_select on rental_contracts for select using (current_role_name() in ('admin','manager'));
create policy contracts_write on rental_contracts for insert with check (current_role_name() in ('admin','manager'));
create policy payments_select on vehicle_payments for select using (current_role_name() in ('admin','manager'));
create policy payments_write on vehicle_payments for insert with check (current_role_name() in ('admin','manager'));

-- ---------------------------------------------------------------------------
-- RLS — HR МОДУЛ
-- ---------------------------------------------------------------------------
alter table wallet_transfers enable row level security;
alter table wallet_transactions enable row level security;
alter table leave_balances enable row level security;
alter table leave_requests enable row level security;
alter table employment_contracts enable row level security;
alter table job_applications enable row level security;
alter table payroll_entries enable row level security;
alter table partner_commission_profiles enable row level security;

create or replace function can_approve_transfers() returns boolean
language sql stable as $$
  select current_role_name() = 'admin'
    or coalesce((select (permissions->>'can_approve_transfers')::boolean from profiles where id = auth.uid()), false)
$$;

-- портфейли: всеки вижда своите движения/заявки; admin/делегиран вижда всички
create policy wallet_tx_select on wallet_transactions for select
  using (user_id = auth.uid() or can_approve_transfers());
create policy wallet_transfers_select on wallet_transfers for select
  using (from_user_id = auth.uid() or to_user_id = auth.uid() or can_approve_transfers());
create policy wallet_transfers_insert on wallet_transfers for insert
  with check (requested_by = auth.uid());
create policy wallet_transfers_decide on wallet_transfers for update
  using (can_approve_transfers());

-- отпуски: служителят вижда своите; мениджърът на екипа + admin виждат/одобряват
create policy leave_balances_select on leave_balances for select
  using (profile_id = auth.uid() or current_role_name() in ('admin','manager'));
create policy leave_requests_select on leave_requests for select
  using (
    profile_id = auth.uid() or current_role_name() = 'admin'
    or exists (select 1 from profiles p where p.id = profile_id and p.manager_id = auth.uid())
  );
create policy leave_requests_insert on leave_requests for insert with check (profile_id = auth.uid());
create policy leave_requests_decide on leave_requests for update
  using (
    current_role_name() = 'admin'
    or exists (select 1 from profiles p where p.id = profile_id and p.manager_id = auth.uid())
  );

-- лични договори: служителят вижда своите; admin/manager всички
create policy employment_contracts_select on employment_contracts for select
  using (profile_id = auth.uid() or current_role_name() in ('admin','manager'));
create policy employment_contracts_write on employment_contracts for insert
  with check (current_role_name() in ('admin','manager'));

-- кандидатури: публична форма (insert без вход — обслужва се през service role
-- от бекенда, не директно от anon ключа); преглед само от admin/manager
create policy job_applications_select on job_applications for select
  using (current_role_name() in ('admin','manager'));
create policy job_applications_decide on job_applications for update
  using (current_role_name() in ('admin','manager'));

-- заплати: шофьорът вижда/подписва своите; admin/manager всички
create policy payroll_select on payroll_entries for select
  using (profile_id = auth.uid() or current_role_name() in ('admin','manager'));
create policy payroll_write on payroll_entries for insert with check (current_role_name() in ('admin','manager'));
create policy payroll_sign on payroll_entries for update
  using (profile_id = auth.uid() or current_role_name() in ('admin','manager'));

-- партньорски комисионни: само admin
create policy partner_commission_select on partner_commission_profiles for select
  using (profile_id = auth.uid() or current_role_name() = 'admin');
create policy partner_commission_write on partner_commission_profiles for insert
  with check (current_role_name() = 'admin');

-- ---------------------------------------------------------------------------
-- ПОЛЕЗНИ ИЗГЛЕДИ ЗА СТАТИСТИКА
-- ---------------------------------------------------------------------------
create or replace view vehicle_cost_summary as
select
  v.id as vehicle_id,
  v.plate_number,
  v.make,
  v.model,
  v.purchase_price,
  coalesce(sr.total_service_cost, 0) as total_service_cost,
  coalesce(rc.total_recurring_cost, 0) as total_recurring_cost,
  coalesce(v.purchase_price, 0) + coalesce(sr.total_service_cost, 0) + coalesce(rc.total_recurring_cost, 0) as total_cost_to_date
from vehicles v
left join (
  select vehicle_id, sum(cost) as total_service_cost
  from service_records group by vehicle_id
) sr on sr.vehicle_id = v.id
left join (
  select vehicle_id, sum(amount) as total_recurring_cost
  from vehicle_recurring_costs group by vehicle_id
) rc on rc.vehicle_id = v.id;

create or replace view vehicle_profit_summary as
select
  v.id as vehicle_id,
  v.plate_number,
  coalesce(income.total_income, 0) as total_income,
  coalesce(expense.total_expense, 0) as total_expense,
  coalesce(income.total_income, 0) - coalesce(expense.total_expense, 0) as net_profit
from vehicles v
left join (
  select vehicle_id, sum(amount) as total_income from vehicle_payments
  where direction = 'income' group by vehicle_id
) income on income.vehicle_id = v.id
left join (
  select vehicle_id, sum(amount) as total_expense from vehicle_payments
  where direction = 'expense' group by vehicle_id
) expense on expense.vehicle_id = v.id;

create or replace view vehicle_utilization as
select
  v.id as vehicle_id,
  v.plate_number,
  v.purchase_date,
  coalesce(sum(
    (coalesce(a.end_date, current_date) - a.start_date)
  ), 0) as days_assigned,
  greatest(current_date - coalesce(v.purchase_date, current_date), 1) as days_owned,
  round(
    100.0 * coalesce(sum((coalesce(a.end_date, current_date) - a.start_date)), 0)
    / greatest(current_date - coalesce(v.purchase_date, current_date), 1)
  , 1) as utilization_pct
from vehicles v
left join vehicle_assignments a on a.vehicle_id = v.id
group by v.id, v.plate_number, v.purchase_date;

-- ---------------------------------------------------------------------------
-- STORAGE BUCKETS (изпълнява се отделно през Supabase Storage API/UI)
-- ---------------------------------------------------------------------------
-- vehicle-photos      — снимки на протоколи, състояние на колата
-- talon-scans         — снимки на талони
-- documents           — договори, фактури (PDF)
-- hr-documents        — лични карти, шофьорски книжки, кандидатури (self-application)
