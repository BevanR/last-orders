-- Initial schema. The app is the only component with database access.

CREATE TABLE case_versions (
  id serial PRIMARY KEY,
  case_id text NOT NULL,
  sha256 text NOT NULL UNIQUE,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code text NOT NULL UNIQUE,
  host_token_hash text NOT NULL UNIQUE,
  case_version_id int NOT NULL REFERENCES case_versions(id),
  act int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'active', 'ended')),
  -- Incremented on every state change.
  revision int NOT NULL DEFAULT 0,
  -- Last assigned game_events.seq. Bumped under the game row lock, so seq order is commit order.
  event_seq bigint NOT NULL DEFAULT 0,
  spend_cents numeric(12, 4) NOT NULL DEFAULT 0,
  spend_cap_cents int NOT NULL DEFAULT 300,
  last_progress_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  session_token_hash text NOT NULL UNIQUE,
  is_host boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_game ON players(game_id);
CREATE UNIQUE INDEX players_one_host ON players(game_id) WHERE is_host;

CREATE TABLE suspect_states (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  suspect_id text NOT NULL,
  state text NOT NULL,
  revision int NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, suspect_id)
);

CREATE TABLE testimony_transitions (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  suspect_id text NOT NULL,
  transition_id text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  evidence_id text NOT NULL,
  fired_by uuid NOT NULL REFERENCES players(id),
  fired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, suspect_id, transition_id)
);

CREATE TABLE location_visits (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES players(id),
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, location_id, player_id)
);

CREATE TABLE evidence_discoveries (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES players(id),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  shared_at timestamptz,
  UNIQUE (game_id, evidence_id, player_id)
);

CREATE TABLE board_items (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  shared_by uuid NOT NULL REFERENCES players(id),
  shared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, evidence_id)
);

CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id),
  suspect_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, player_id, suspect_id)
);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid REFERENCES players(id),
  kind text NOT NULL,
  -- Jobs sharing a serial_key run one at a time, oldest first.
  serial_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE,
  -- The suspect revision the claimed context was built from.
  input_revision int,
  payload jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  usage jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX jobs_pending ON jobs(id) WHERE status = 'pending';
CREATE INDEX jobs_running_lease ON jobs(lease_expires_at) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_one_running_per_serial_key ON jobs(serial_key) WHERE status = 'running';

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('player', 'suspect', 'system')),
  text text NOT NULL,
  presented_evidence_id text,
  job_id bigint REFERENCES jobs(id),
  simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_interview ON messages(interview_id, id);
-- A job produces at most one message, however many times it is completed.
CREATE UNIQUE INDEX messages_one_per_job ON messages(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE game_events (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  -- 'public', 'host', or 'player:<uuid>'.
  audience text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, seq)
);

CREATE TABLE game_interventions (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- 'hint:<id>' or 'event:<id>'.
  intervention_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, intervention_id)
);

CREATE TABLE accusations (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id),
  suspect_id text NOT NULL,
  evidence_ids text[] NOT NULL DEFAULT '{}',
  correct boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
