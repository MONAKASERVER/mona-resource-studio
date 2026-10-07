CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE system_role AS ENUM ('admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE project_role AS ENUM ('owner', 'admin', 'manager', 'editor', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE review_status AS ENUM ('draft', 'open', 'approved', 'changes_requested', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE build_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9_.-]{3,32}$'),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  password_hash TEXT NOT NULL,
  system_role system_role NOT NULL DEFAULT 'user',
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_active_idx ON refresh_tokens(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 16 AND 2048),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS passkey_credentials_user_idx ON passkey_credentials(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS passkey_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('login', 'register')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  options JSONB NOT NULL,
  credential_name TEXT,
  browser_token_hash CHAR(64) NOT NULL,
  poll_token_hash CHAR(64) NOT NULL,
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passkey_flows_expiry_idx ON passkey_flows(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  minecraft_version TEXT NOT NULL DEFAULT '1.21.11',
  storage_key TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role project_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id, project_id);

CREATE TABLE IF NOT EXISTS project_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 CHAR(64) NOT NULL,
  mime_type TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS project_files_project_path_idx ON project_files(project_id, path);

CREATE TABLE IF NOT EXISTS file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, version)
);

CREATE TABLE IF NOT EXISTS file_locks (
  file_id UUID PRIMARY KEY REFERENCES project_files(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id),
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logical_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  logical_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_item_id TEXT NOT NULL,
  texture_ref TEXT,
  model_ref TEXT,
  command_template JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, logical_id)
);

CREATE TABLE IF NOT EXISTS cit_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  logical_item_id UUID REFERENCES logical_items(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  source_path TEXT NOT NULL,
  normalized JSONB NOT NULL,
  unknown_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (project_id, source_path)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  manifest JSONB NOT NULL,
  artifact_key TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id UUID REFERENCES project_files(id) ON DELETE CASCADE,
  logical_item_id UUID REFERENCES logical_items(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  anchor JSONB,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE comments ADD COLUMN IF NOT EXISTS logical_item_id UUID REFERENCES logical_items(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS comments_project_created_idx ON comments(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS review_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL REFERENCES snapshots(id),
  base_snapshot_id UUID REFERENCES snapshots(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status review_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS base_snapshot_id UUID REFERENCES snapshots(id);
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS review_requests_project_created_idx ON review_requests(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS build_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL REFERENCES snapshots(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  status build_status NOT NULL DEFAULT 'queued',
  profile TEXT NOT NULL DEFAULT 'development' CHECK (profile IN ('development', 'release')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  log_key TEXT,
  artifact_key TEXT,
  artifact_sha256 CHAR(64),
  artifact_size BIGINT CHECK (artifact_size IS NULL OR artifact_size >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'development';
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS artifact_size BIGINT;
CREATE INDEX IF NOT EXISTS build_jobs_project_created_idx ON build_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_project_created_idx ON snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  build_id UUID NOT NULL REFERENCES build_jobs(id),
  approved_review_id UUID REFERENCES review_requests(id),
  version TEXT NOT NULL,
  release_notes TEXT NOT NULL DEFAULT '',
  artifact_key TEXT,
  artifact_sha256 CHAR(64),
  artifact_size BIGINT CHECK (artifact_size IS NULL OR artifact_size >= 0),
  published_by UUID NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
ALTER TABLE releases ADD COLUMN IF NOT EXISTS approved_review_id UUID REFERENCES review_requests(id);
ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifact_key TEXT;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifact_sha256 CHAR(64);
ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifact_size BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS releases_build_unique_idx ON releases(build_id);
CREATE INDEX IF NOT EXISTS releases_project_published_idx ON releases(project_id, published_at DESC);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_project_time_idx ON activity_logs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_project_time_idx ON audit_logs(project_id, created_at DESC);
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('mona.audit_maintenance', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
