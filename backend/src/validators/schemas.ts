import { z } from 'zod';

/**
 * Transport validation (D5).
 *
 * One schema per boundary, used for REST bodies/params and for Socket.IO
 * payloads. Every string has a maximum length: unbounded input is how a text
 * column becomes a memory-pressure vector.
 */

export const uuid = z.string().uuid('Must be a valid UUID');

export const displayName = z
  .string()
  .trim()
  .min(1, 'Display name is required')
  .max(40, 'Display name must be 40 characters or fewer');

export const createSessionBody = z.object({
  displayName,
  // Device-generated and opaque to the server; bounded so it cannot be abused
  // as arbitrary storage.
  deviceId: z.string().trim().min(8, 'deviceId must be at least 8 characters').max(128),
});

export const createRoomBody = z.object({
  name: z.string().trim().min(1).max(60).default('Roxstar Room'),
});

export const roomIdParam = z.object({ roomId: uuid });

/** Join accepts either a room UUID or a short join code. */
export const joinRoomParam = z.object({
  roomIdOrCode: z
    .string()
    .trim()
    .min(4)
    .max(36)
    .regex(/^[A-Za-z0-9-]+$/, 'Must be a room id or join code'),
});

export const audioEffect = z.enum(['NONE', 'ECHO', 'REVERB', 'PITCH_SHIFT']);

export const draftBody = z.object({
  draftId: uuid,
  name: z.string().trim().min(1).max(80),
  // Upper bound matches the CHECK constraint on drafts.duration_ms.
  durationMs: z.number().int().positive().max(3_600_000),
  effect: audioEffect.default('NONE'),
  hostedFileUrl: z
    .string()
    .trim()
    .max(2048)
    .url('hostedFileUrl must be a valid URL')
    .nullish()
    .transform((v) => v ?? null),
});

export const draftIdParam = z.object({ draftId: uuid });

/** Start Spin takes no body; the server decides eligibility from room state. */
export const startSpinBody = z.object({}).passthrough().optional();

export const subscribeRoomPayload = z.object({ roomId: uuid });

export type CreateSessionBody = z.infer<typeof createSessionBody>;
export type CreateRoomBody = z.infer<typeof createRoomBody>;
export type DraftBody = z.infer<typeof draftBody>;
