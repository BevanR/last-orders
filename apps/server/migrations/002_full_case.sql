-- The full case: testimony threads, location actions, act timing, game-master ticks,
-- the group accusation and the reveal commentary.

-- One row per suspect testimony thread.
ALTER TABLE suspect_states ADD COLUMN thread_id text NOT NULL DEFAULT 'main';
ALTER TABLE suspect_states DROP CONSTRAINT suspect_states_pkey;
ALTER TABLE suspect_states ADD PRIMARY KEY (game_id, suspect_id, thread_id);
ALTER TABLE suspect_states ALTER COLUMN thread_id DROP DEFAULT;

-- A visit is one visible action at a location.
ALTER TABLE location_visits ADD COLUMN action_id text NOT NULL DEFAULT '';
ALTER TABLE location_visits DROP CONSTRAINT location_visits_pkey;
ALTER TABLE location_visits ADD PRIMARY KEY (game_id, location_id, action_id, player_id);
ALTER TABLE location_visits ALTER COLUMN action_id DROP DEFAULT;

-- act number (as text) -> when it started.
ALTER TABLE games ADD COLUMN act_started_at jsonb NOT NULL DEFAULT '{}';
-- Last player action; the game master stops ticking for idle games.
ALTER TABLE games ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
-- Last time a gm_tick job was enqueued.
ALTER TABLE games ADD COLUMN last_gm_tick_at timestamptz;
ALTER TABLE games ADD COLUMN ended_at timestamptz;
-- Model commentary on the reveal, written after the game ends. Always labelled as commentary.
ALTER TABLE games ADD COLUMN commentary text;
ALTER TABLE games ADD COLUMN commentary_simulated boolean NOT NULL DEFAULT false;

-- The authored text as delivered, and who delivered it ('gm' or 'host').
ALTER TABLE game_interventions ADD COLUMN text text NOT NULL DEFAULT '';
ALTER TABLE game_interventions ADD COLUMN source text NOT NULL DEFAULT 'gm';

-- One group accusation per game. The outcome id is stored but only shown at the reveal.
DROP TABLE accusations;
CREATE TABLE accusations (
  game_id uuid PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id),
  suspect_id text NOT NULL,
  evidence_ids text[] NOT NULL DEFAULT '{}',
  reasoning text NOT NULL DEFAULT '',
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_presented ON messages(interview_id) WHERE presented_evidence_id IS NOT NULL;
CREATE INDEX jobs_game_kind_open ON jobs(game_id, kind) WHERE status IN ('pending', 'running');
