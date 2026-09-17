import { query, type Queryable } from '../db/pool.js';
import type { AudioEffect, Draft, SharedDraft } from '../models/types.js';

interface DraftRow {
  id: string;
  owner_id: string;
  name: string;
  duration_ms: number;
  effect: AudioEffect;
  hosted_file_url: string | null;
  created_at: Date;
}

interface SharedRow {
  id: string;
  room_id: string;
  draft_id: string;
  shared_by: string;
  shared_at: Date;
  d_id: string;
  d_owner_id: string;
  d_name: string;
  d_duration_ms: number;
  d_effect: AudioEffect;
  d_hosted_file_url: string | null;
  d_created_at: Date;
}

const DRAFT_COLS = 'id, owner_id, name, duration_ms, effect, hosted_file_url, created_at';

const map = (r: DraftRow): Draft => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  durationMs: r.duration_ms,
  effect: r.effect,
  hostedFileUrl: r.hosted_file_url,
  createdAt: r.created_at,
});

export interface DraftInput {
  id: string;
  ownerId: string;
  name: string;
  durationMs: number;
  effect: AudioEffect;
  hostedFileUrl?: string | null;
}

/**
 * Register (or refresh) draft metadata (D10).
 *
 * The draft id is minted on the device, so the row is an upsert keyed on that
 * id. The WHERE clause on the update is the authorisation check: a second user
 * replaying someone else's draft id cannot overwrite their metadata.
 */
export async function upsertDraft(input: DraftInput, db: Queryable = { query }): Promise<Draft | null> {
  const { rows } = await db.query<DraftRow>(
    `INSERT INTO drafts (id, owner_id, name, duration_ms, effect, hosted_file_url)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
        SET name            = EXCLUDED.name,
            duration_ms     = EXCLUDED.duration_ms,
            effect          = EXCLUDED.effect,
            hosted_file_url = EXCLUDED.hosted_file_url
      WHERE drafts.owner_id = EXCLUDED.owner_id
      RETURNING ${DRAFT_COLS}`,
    [input.id, input.ownerId, input.name, input.durationMs, input.effect, input.hostedFileUrl ?? null],
  );
  // No row means the id exists under a different owner -- treated as 404 by
  // the service so the response does not confirm that the draft exists.
  return rows[0] ? map(rows[0]) : null;
}

export async function findDraftById(id: string, db: Queryable = { query }): Promise<Draft | null> {
  const { rows } = await db.query<DraftRow>(`SELECT ${DRAFT_COLS} FROM drafts WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listDraftsByOwner(
  ownerId: string,
  db: Queryable = { query },
): Promise<Draft[]> {
  const { rows } = await db.query<DraftRow>(
    `SELECT ${DRAFT_COLS} FROM drafts WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [ownerId],
  );
  return rows.map(map);
}

export async function deleteDraft(
  id: string,
  ownerId: string,
  db: Queryable = { query },
): Promise<boolean> {
  const res = await db.query('DELETE FROM drafts WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return (res.rowCount ?? 0) > 0;
}

export async function recordShare(
  roomId: string,
  draftId: string,
  sharedBy: string,
  db: Queryable = { query },
): Promise<{ id: string; sharedAt: Date }> {
  const { rows } = await db.query<{ id: string; shared_at: Date }>(
    `INSERT INTO room_shared_drafts (room_id, draft_id, shared_by)
          VALUES ($1, $2, $3)
       RETURNING id, shared_at`,
    [roomId, draftId, sharedBy],
  );
  const row = rows[0] as { id: string; shared_at: Date };
  return { id: row.id, sharedAt: row.shared_at };
}

/** Most recently shared draft in a room -- what `room_state` reports. */
export async function findLatestSharedDraft(
  roomId: string,
  db: Queryable = { query },
): Promise<SharedDraft | null> {
  const { rows } = await db.query<SharedRow>(
    `SELECT s.id, s.room_id, s.draft_id, s.shared_by, s.shared_at,
            d.id AS d_id, d.owner_id AS d_owner_id, d.name AS d_name,
            d.duration_ms AS d_duration_ms, d.effect AS d_effect,
            d.hosted_file_url AS d_hosted_file_url, d.created_at AS d_created_at
       FROM room_shared_drafts s
       JOIN drafts d ON d.id = s.draft_id
      WHERE s.room_id = $1
      ORDER BY s.shared_at DESC, s.id DESC
      LIMIT 1`,
    [roomId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    roomId: r.room_id,
    draftId: r.draft_id,
    sharedBy: r.shared_by,
    sharedAt: r.shared_at,
    draft: {
      id: r.d_id,
      ownerId: r.d_owner_id,
      name: r.d_name,
      durationMs: r.d_duration_ms,
      effect: r.d_effect,
      hostedFileUrl: r.d_hosted_file_url,
      createdAt: r.d_created_at,
    },
  };
}
