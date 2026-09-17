import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { Attendee, DemoState, Reservation, Workshop } from "../shared/types.ts";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(moduleDirectory, "../../migrations");

interface WorkshopRow extends QueryResultRow {
  id: string;
  title: string;
  description: string;
  starts_at: Date | string;
  ends_at: Date | string;
  tags: string[];
  capacity: number;
  remaining_capacity: number;
}

interface ReservationRow extends QueryResultRow {
  id: string;
  request_id: string;
  workshop_id: string;
  workshop_title: string;
  attendee_id: string;
  attendee_name: string;
  attendee_email: string;
  created_at: Date | string;
}

type ReserveSeatResult =
  | { status: "confirmed"; reservation: Reservation; replayed: boolean }
  | { status: "unavailable"; workshopId: string; reason: string };

type GetReservationResult =
  | { status: "confirmed"; reservation: Reservation }
  | { status: "not_found"; requestId: string };

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(requestId: string) {
    super(`Booking request ${requestId} was already used with different parameters`);
    this.name = "IdempotencyConflictError";
  }
}

export class WorkshopNotFoundError extends Error {
  readonly code = "WORKSHOP_NOT_FOUND";

  constructor(workshopId: string) {
    super(`Workshop ${workshopId} does not exist`);
    this.name = "WorkshopNotFoundError";
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapWorkshop(row: WorkshopRow): Workshop {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    tags: row.tags,
    capacity: row.capacity,
    remainingCapacity: row.remaining_capacity
  };
}

function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    requestId: row.request_id,
    workshopId: row.workshop_id,
    workshopTitle: row.workshop_title,
    attendeeId: row.attendee_id,
    attendeeName: row.attendee_name,
    attendeeEmail: row.attendee_email,
    createdAt: iso(row.created_at)
  };
}

const reservationSelect = `
  SELECT r.id, r.request_id, r.workshop_id, w.title AS workshop_title,
         r.attendee_id, r.attendee_name, r.attendee_email, r.created_at
  FROM reservations r
  JOIN workshops w ON w.id = r.workshop_id
`;

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 12,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000
  });
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE filename = $1",
      [filename]
    );

    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration ${filename} changed after it was applied`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)",
        [filename, checksum]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function resetDemoData(pool: Pool): Promise<void> {
  const seedSql = await readFile(path.join(migrationsDirectory, "002_seed.sql"), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE reservations");
    await client.query(seedSql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listWorkshops(pool: Pool): Promise<Workshop[]> {
  const result = await pool.query<WorkshopRow>(`
    SELECT id, title, description, starts_at, ends_at, tags, capacity, remaining_capacity
    FROM workshops
    ORDER BY starts_at, id
  `);
  return result.rows.map(mapWorkshop);
}

export async function searchWorkshops(
  pool: Pool,
  input: { topic: string; timeOfDay: "morning" | "afternoon" | "evening" | "any" }
): Promise<Workshop[]> {
  const topicPattern = `%${input.topic.trim()}%`;
  const result = await pool.query<WorkshopRow>(
    `
      SELECT id, title, description, starts_at, ends_at, tags, capacity, remaining_capacity
      FROM workshops
      WHERE (
        title ILIKE $1 OR description ILIKE $1 OR array_to_string(tags, ' ') ILIKE $1
      )
      AND (
        $2 = 'any'
        OR ($2 = 'morning' AND EXTRACT(HOUR FROM starts_at AT TIME ZONE 'UTC') >= 8
                           AND EXTRACT(HOUR FROM starts_at AT TIME ZONE 'UTC') < 12)
        OR ($2 = 'afternoon' AND EXTRACT(HOUR FROM starts_at AT TIME ZONE 'UTC') >= 12
                             AND EXTRACT(HOUR FROM starts_at AT TIME ZONE 'UTC') < 17)
        OR ($2 = 'evening' AND EXTRACT(HOUR FROM starts_at AT TIME ZONE 'UTC') >= 17)
      )
      ORDER BY starts_at, id
    `,
    [topicPattern, input.timeOfDay]
  );
  return result.rows.map(mapWorkshop);
}

async function findReservationWithClient(
  client: PoolClient,
  requestId: string
): Promise<Reservation | undefined> {
  const result = await client.query<ReservationRow>(
    `${reservationSelect} WHERE r.request_id = $1`,
    [requestId]
  );
  const row = result.rows[0];
  return row ? mapReservation(row) : undefined;
}

function assertSameIntent(
  reservation: Reservation,
  workshopId: string,
  attendee: Attendee,
  requestId: string
): void {
  if (
    reservation.workshopId !== workshopId ||
    reservation.attendeeId !== attendee.id ||
    reservation.attendeeName !== attendee.name ||
    reservation.attendeeEmail !== attendee.email
  ) {
    throw new IdempotencyConflictError(requestId);
  }
}

export async function reserveSeat(
  pool: Pool,
  input: { workshopId: string; requestId: string; attendee: Attendee }
): Promise<ReserveSeatResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serializes attempts sharing an idempotency key, including conflicting attempts.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.requestId]);

    const existing = await findReservationWithClient(client, input.requestId);
    if (existing) {
      assertSameIntent(existing, input.workshopId, input.attendee, input.requestId);
      await client.query("COMMIT");
      return { status: "confirmed", reservation: existing, replayed: true };
    }

    const workshopResult = await client.query<WorkshopRow>(
      `
        SELECT id, title, description, starts_at, ends_at, tags, capacity, remaining_capacity
        FROM workshops
        WHERE id = $1
        FOR UPDATE
      `,
      [input.workshopId]
    );
    const workshop = workshopResult.rows[0];
    if (!workshop) {
      throw new WorkshopNotFoundError(input.workshopId);
    }

    if (workshop.remaining_capacity === 0) {
      await client.query("COMMIT");
      return {
        status: "unavailable",
        workshopId: input.workshopId,
        reason: "The workshop has no remaining seats"
      };
    }

    const reservationId = randomUUID();
    const inserted = await client.query<ReservationRow>(
      `
        INSERT INTO reservations (
          id, request_id, workshop_id, attendee_id, attendee_name, attendee_email
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, request_id, workshop_id,
                  (SELECT title FROM workshops WHERE id = $3) AS workshop_title,
                  attendee_id, attendee_name, attendee_email, created_at
      `,
      [
        reservationId,
        input.requestId,
        input.workshopId,
        input.attendee.id,
        input.attendee.name,
        input.attendee.email
      ]
    );
    await client.query(
      `
        UPDATE workshops
        SET remaining_capacity = remaining_capacity - 1
        WHERE id = $1 AND remaining_capacity > 0
      `,
      [input.workshopId]
    );
    await client.query("COMMIT");

    const row = inserted.rows[0];
    if (!row) {
      throw new Error("Reservation insert returned no row");
    }
    return { status: "confirmed", reservation: mapReservation(row), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getReservation(
  pool: Pool,
  requestId: string
): Promise<GetReservationResult> {
  const result = await pool.query<ReservationRow>(
    `${reservationSelect} WHERE r.request_id = $1`,
    [requestId]
  );
  const row = result.rows[0];
  return row
    ? { status: "confirmed", reservation: mapReservation(row) }
    : { status: "not_found", requestId };
}

export async function getDemoState(pool: Pool): Promise<DemoState> {
  const [workshops, reservationsResult] = await Promise.all([
    listWorkshops(pool),
    pool.query<ReservationRow>(`${reservationSelect} ORDER BY r.created_at, r.id`)
  ]);
  return {
    workshops,
    reservations: reservationsResult.rows.map(mapReservation)
  };
}
