/**
 * The single client-side registry of synced tables.
 *
 * Everything on the device that needs to know about a synced table derives from this object:
 * - `schema.ts` builds the PowerSync client schema (SQLite views) from `columns` and `indexes`;
 * - `upload.ts` converts and checks outgoing writes using the column kinds and `writes`;
 * - `scripts/validate-sync-config.mjs` checks that every table here is synced by some stream;
 * - the registry-drift test compares it with the Postgres schema snapshot made by `npm run db:test`.
 *
 * Rules:
 * - `id` is never listed; it is implicit (TEXT on the device, uuid in Postgres).
 * - Column kinds mirror the Postgres types (see SPEC "Postgres → device types"); `json` is jsonb,
 *   `timestamp` is timestamptz, `real` is double precision, `integer` covers smallint and integer.
 * - `writes` must agree with the grants, RLS policies and triggers in supabase/migrations. A write the
 *   server would reject anyway is refused before upload (see `planOperation`), so it lands in the local
 *   `upload_failures` log instead of being sent.
 *
 * This file must stay free of imports and of non-erasable TypeScript syntax (no enums, namespaces or
 * parameter properties): `scripts/validate-sync-config.mjs` imports it directly with Node's built-in
 * type stripping, so the validator always reads the real registry rather than a copy or a regex parse.
 */

export type ColumnKind = 'uuid' | 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'timestamp' | 'date';

export type WritePolicy = {
  /**
   * How a local INSERT (PowerSync PUT) is uploaded:
   * - 'upsert': `INSERT ... ON CONFLICT (id) DO UPDATE` — idempotent when a half-uploaded
   *   transaction is retried; needs SELECT + INSERT + UPDATE grants and policies on every sent column.
   * - 'insert-ignore': `INSERT ... ON CONFLICT (id) DO NOTHING` — for rows that are never updated by
   *   the client (append-only logs, or tables where only some columns may be updated); needs INSERT only.
   * - false: the device may not create rows in this table.
   */
  put: 'upsert' | 'insert-ignore' | false;
  /** true = any registry column may be changed; a list = only those columns; false = no updates. */
  patch: boolean | readonly string[];
  delete: boolean;
  /**
   * Columns the server always fills in itself: either the client has no privilege to write them (e.g.
   * groups.invite_code, made by the column default and changed only by regenerate_invite_code() and
   * remove_group_member()), or a server trigger always replaces what the client sends (cards.source_id,
   * derived from the card's source chunk).
   * They sync down like any other column but are never uploaded: `planOperation` strips them from
   * every PUT (a locally created row may hold null or a placeholder there), and refuses a PATCH that
   * changes one (DUALREP_WRITE_NOT_ALLOWED), because no device code should ever do that.
   */
  serverGenerated?: readonly string[];
  /**
   * Columns that only make sense together (card_states: one FSRS state). A PATCH that changes any of
   * them uploads all of them, with their values after the local update, instead of only the changed
   * ones. Why: the server keeps or skips a card_states write as a whole (skip_stale_card_state compares
   * last_review), and a PATCH of only the changed columns could land on top of another device's newer
   * state and leave a mix of both (stability from one review, due from the other).
   * The values come from the operation itself: `schema.ts` turns on PowerSync's `trackPrevious` for
   * these columns, so each queued PATCH carries the row's values before the update (`previousValues`),
   * and the values after it are those plus the changed ones. A PATCH queued by an app version that did
   * not track them yet has no `previousValues` and uploads only the changed columns, as before.
   */
  patchTogether?: readonly string[];
};

export type TableDefinition = {
  columns: Readonly<Record<string, ColumnKind>>;
  writes: WritePolicy;
  /** Local SQLite indexes (PowerSync index shorthand: name → column list). */
  indexes?: Readonly<Record<string, readonly string[]>>;
};

/** Every table is written by its owner through the API: create, change and delete. */
const OWNER_WRITES = { put: 'upsert', patch: true, delete: true } as const satisfies WritePolicy;

/** Server-maintained timestamps present on every table (set by defaults and the set_updated_at trigger). */
const TIMESTAMPS = { created_at: 'timestamp', updated_at: 'timestamp' } as const;

export const TABLES = {
  profiles: {
    columns: {
      display_name: 'text',
      unit_pref: 'text',
      default_block_minutes: 'integer',
      default_preset_id: 'uuid',
      default_setup_id: 'uuid',
      fsrs_params: 'json',
      ...TIMESTAMPS,
    },
    // The row is created by the handle_new_user() trigger; the client edits it but never deletes it
    // (account deletion cascades from auth.users).
    writes: { put: 'upsert', patch: true, delete: false },
  },

  entitlements: {
    columns: {
      user_id: 'uuid',
      tier: 'text',
      source: 'text',
      expires_at: 'timestamp',
      ...TIMESTAMPS,
    },
    // Written only by the service role (store webhook / beta tooling). Grants: select only.
    writes: { put: false, patch: false, delete: false },
  },

  presets: {
    columns: {
      owner_id: 'uuid',
      name: 'text',
      kind: 'text',
      split: 'json',
      ...TIMESTAMPS,
    },
    // RLS limits writes to the caller's own presets; system presets (owner_id null) are read-only.
    writes: OWNER_WRITES,
  },

  equipment_setups: {
    columns: {
      user_id: 'uuid',
      name: 'text',
      location: 'text',
      equipment: 'json',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_user: ['user_id'] },
  },

  exercises: {
    columns: {
      name: 'text',
      muscle_group: 'text',
      secondary_muscles: 'json',
      body_region: 'text',
      category: 'text',
      dataset_category: 'text',
      equipment: 'json',
      location: 'text',
      movement_pattern: 'text',
      demand_level: 'integer',
      level: 'text',
      force: 'text',
      mechanic: 'text',
      micro_ok: 'boolean',
      instructions: 'json',
      images: 'json',
      origin: 'text',
      dataset_id: 'text',
      reviewed: 'boolean',
      owner_id: 'uuid',
      group_id: 'uuid',
      ...TIMESTAMPS,
    },
    // Library rows (dataset/interverse) are service-role only; RLS allows writes to own 'user' rows,
    // and CHECKs keep a user row from ever holding a dataset_id or reviewed = true. A group_id naming a
    // group the owner is not (or no longer) a member of is stored as null: the row is kept, unshared
    // (same for sources and study_plans).
    writes: OWNER_WRITES,
    indexes: { by_pattern: ['movement_pattern', 'location'], by_owner: ['owner_id'], by_group: ['group_id'] },
  },

  study_sessions: {
    columns: {
      user_id: 'uuid',
      plan_id: 'uuid',
      focus_subject: 'text',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_user_created: ['user_id', 'created_at'] },
  },

  interval_blocks: {
    columns: {
      user_id: 'uuid',
      study_session_id: 'uuid',
      planned_minutes: 'integer',
      started_at: 'timestamp',
      ended_at: 'timestamp',
      interrupted: 'boolean',
      effort_rating: 'integer',
      mode: 'text',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_session: ['study_session_id'] },
  },

  workout_sessions: {
    columns: {
      user_id: 'uuid',
      logged_at: 'timestamp',
      kind: 'text',
      preset_id: 'uuid',
      setup_id: 'uuid',
      duration_minutes: 'integer',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_user_logged: ['user_id', 'logged_at'] },
  },

  exercise_sets: {
    columns: {
      user_id: 'uuid',
      workout_session_id: 'uuid',
      // null once the exercise is deleted (ON DELETE SET NULL): another person's exercise must never
      // block their account deletion. When the device sets it to an exercise the user cannot read
      // (e.g. unshared, or its owner left the group, before the upload) or one that no longer exists,
      // the server stores the set with exercise_id null instead of refusing it.
      exercise_id: 'uuid',
      // The exercise's name, copied by the device when the set is logged, so the history stays
      // readable after the exercise is deleted, unshared or otherwise no longer visible.
      exercise_name: 'text',
      set_index: 'integer',
      reps: 'integer',
      weight_lbs: 'real',
      rpe: 'real',
      target_reps: 'integer',
      target_weight_lbs: 'real',
      rest_seconds: 'integer',
      set_type: 'text',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_session: ['workout_session_id', 'set_index'], by_exercise: ['exercise_id'] },
  },

  transitions: {
    columns: {
      user_id: 'uuid',
      interval_block_id: 'uuid',
      workout_session_id: 'uuid',
      proposal: 'json',
      accepted: 'boolean',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_block: ['interval_block_id'] },
  },

  groups: {
    columns: {
      owner_id: 'uuid',
      name: 'text',
      invite_code: 'text',
      ...TIMESTAMPS,
    },
    // Grants are `update(name)` only. A PostgREST upsert puts every sent column in
    // `ON CONFLICT DO UPDATE SET ...`, and Postgres checks UPDATE privilege on all of them even when
    // there is no conflict (verified on Postgres 16: "permission denied for table groups"). So a new
    // group is uploaded as insert-ignore (needs INSERT only; a retried upload is a no-op) and renames
    // go through PATCH, which may only touch `name`.
    // The server always picks the invite code: INSERT is granted on (id, owner_id, name, created_at,
    // updated_at) only, so invite_code is never sent. The new group's code arrives with the next sync.
    writes: { put: 'insert-ignore', patch: ['name'], delete: true, serverGenerated: ['invite_code'] },
  },

  group_members: {
    columns: {
      group_id: 'uuid',
      user_id: 'uuid',
      role: 'text',
      ...TIMESTAMPS,
    },
    // Joins go through the join_group() RPC. The only client DELETE is leaving: the server's DELETE
    // policy admits the caller's own (non-owner) membership only. The owner removes someone else with
    // the remove_group_member() RPC, called online (it deletes the membership and rotates the invite
    // code in one transaction); a queued local DELETE of another member's row would change nothing on
    // the server, and the row would come back with the next sync.
    writes: { put: false, patch: false, delete: true },
    indexes: { by_group: ['group_id'], by_user: ['user_id'] },
  },

  sources: {
    columns: {
      owner_id: 'uuid',
      group_id: 'uuid',
      kind: 'text',
      title: 'text',
      url: 'text',
      // pending -> processing -> ready | failed, moved on by the study pipeline (the `study` Edge
      // Function and the tracy-worker). The server ignores what the device sends here (a new source is
      // stored as pending, an update keeps the stored status), so the device never needs to write it.
      status: 'text',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
  },

  source_files: {
    columns: {
      source_id: 'uuid',
      // owner_id/group_id are copied from the parent source by a server trigger; whatever the device
      // sends is overwritten, so they cannot be forged.
      owner_id: 'uuid',
      group_id: 'uuid',
      storage_path: 'text',
      page: 'integer',
      transcript: 'text',
      confirmed: 'boolean',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_source: ['source_id', 'page'] },
  },

  study_plans: {
    columns: {
      owner_id: 'uuid',
      group_id: 'uuid',
      title: 'text',
      scope: 'text',
      goal: 'text',
      target_date: 'date',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
  },

  plan_sources: {
    columns: {
      plan_id: 'uuid',
      source_id: 'uuid',
      added_at: 'timestamp',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_plan: ['plan_id'] },
  },

  topics: {
    columns: {
      plan_id: 'uuid',
      title: 'text',
      position: 'integer',
      // draft (proposed by the study builder, waiting for the outline review) -> confirmed (kept; its
      // cards are being made) -> ready. A topic made by hand is ready (the server default).
      status: 'text',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_plan: ['plan_id', 'position'] },
  },

  cards: {
    columns: {
      topic_id: 'uuid',
      // Copied from the topic by a server trigger (denormalized so cards sync in one bucket per plan).
      plan_id: 'uuid',
      source_chunk_id: 'uuid',
      // The card's source, derived by the server from source_chunk_id (source_chunks never sync), for
      // the "newest source" filter and the "p. 12 of Lecture 3" citation. Null for a hand-made card.
      source_id: 'uuid',
      page: 'integer',
      question: 'text',
      answer: 'text',
      card_type: 'text',
      ...TIMESTAMPS,
    },
    writes: { ...OWNER_WRITES, serverGenerated: ['source_id'] },
    indexes: { by_topic: ['topic_id'], by_plan: ['plan_id'], by_source: ['plan_id', 'source_id'] },
  },

  card_links: {
    columns: {
      from_card_id: 'uuid',
      to_card_id: 'uuid',
      plan_id: 'uuid',
      created_by: 'uuid',
      relation: 'text',
      note: 'text',
      ...TIMESTAMPS,
    },
    writes: OWNER_WRITES,
    indexes: { by_from: ['from_card_id'], by_to: ['to_card_id'] },
  },

  card_states: {
    // ts-fsrs `Card` field names, so a row can be handed to ts-fsrs directly. The id must be
    // UUIDv5(CARD_STATE_ID_NAMESPACE, `${user_id}:${card_id}`) (see constants.ts); the server refuses
    // any other id.
    columns: {
      user_id: 'uuid',
      card_id: 'uuid',
      state: 'integer',
      due: 'timestamp',
      stability: 'real',
      difficulty: 'real',
      scheduled_days: 'integer',
      learning_steps: 'integer',
      reps: 'integer',
      lapses: 'integer',
      last_review: 'timestamp',
      suspended: 'boolean',
      ...TIMESTAMPS,
    },
    // A review changes the FSRS state; it uploads as one whole state (see patchTogether). `suspended`
    // is the user's own switch and uploads on its own.
    writes: {
      ...OWNER_WRITES,
      patchTogether: [
        'state',
        'due',
        'stability',
        'difficulty',
        'scheduled_days',
        'learning_steps',
        'reps',
        'lapses',
        'last_review',
      ],
    },
    // The due list is `WHERE user_id = ? AND due <= ? ORDER BY due`.
    indexes: { user_due: ['user_id', 'due'], by_card: ['card_id'] },
  },

  reviews: {
    // Append-only answer log; state/due_at/stability/difficulty/scheduled_days are the values AFTER
    // the review (ts-fsrs RecordLogItem.card), prev_state is the state before it.
    columns: {
      user_id: 'uuid',
      card_id: 'uuid',
      interval_block_id: 'uuid',
      rating: 'integer',
      answer_mode: 'text',
      reviewed_at: 'timestamp',
      duration_ms: 'integer',
      prev_state: 'integer',
      elapsed_days: 'integer',
      state: 'integer',
      due_at: 'timestamp',
      stability: 'real',
      difficulty: 'real',
      scheduled_days: 'integer',
      ...TIMESTAMPS,
    },
    // Grants: select, insert. ON CONFLICT DO NOTHING makes a retried upload harmless.
    writes: { put: 'insert-ignore', patch: false, delete: false },
    indexes: { card_time: ['card_id', 'reviewed_at'], user_time: ['user_id', 'reviewed_at'] },
  },

  tracy_events: {
    // Light columns only: the sync config selects exactly these, so the large input/output/usage
    // JSON and the worker bookkeeping (attempts, locked_at, model, cap_units, counted_at, ran,
    // releases) stay on the server.
    columns: {
      user_id: 'uuid',
      job: 'text',
      // The pipeline step: extract, transcribe, outline, cards or embed (null outside the study pipeline).
      stage: 'text',
      // What the job works on, for per-source progress and errors; null once the plan or source is gone.
      plan_id: 'uuid',
      source_id: 'uuid',
      status: 'text',
      // Short and content-free; shown next to "Try again".
      error: 'text',
      accepted: 'boolean',
      ...TIMESTAMPS,
    },
    // Rows are created and worked by Edge Functions (every column above is server-written); the user
    // may only accept or reject a result.
    writes: { put: false, patch: ['accepted'], delete: false },
    indexes: { by_user_created: ['user_id', 'created_at'], by_source: ['source_id', 'created_at'] },
  },
} as const satisfies Record<string, TableDefinition>;

export type TableName = keyof typeof TABLES;

/** Synced table names in registry order. */
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/**
 * Columns that exist in Postgres but are deliberately not synced to the device. The registry-drift
 * test requires every other Postgres column of a synced table to be in the registry.
 */
export const SERVER_ONLY_COLUMNS: Readonly<Partial<Record<TableName, readonly string[]>>> = {
  tracy_events: ['input', 'output', 'attempts', 'locked_at', 'model', 'usage', 'cap_units', 'counted_at', 'ran', 'releases'],
};

/** Tables that exist in Postgres but must never be synced (pgvector embeddings stay on the server). */
export const SERVER_ONLY_TABLES = ['source_chunks'] as const;

export function isTableName(name: string): name is TableName {
  return Object.prototype.hasOwnProperty.call(TABLES, name);
}
