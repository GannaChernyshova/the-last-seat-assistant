CREATE TABLE IF NOT EXISTS workshops (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  capacity integer NOT NULL CHECK (capacity >= 0),
  remaining_capacity integer NOT NULL CHECK (
    remaining_capacity >= 0 AND remaining_capacity <= capacity
  )
);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  workshop_id text NOT NULL REFERENCES workshops(id),
  attendee_id text NOT NULL,
  attendee_name text NOT NULL,
  attendee_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservations_request_id_unique UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS reservations_workshop_id_idx
  ON reservations(workshop_id);
