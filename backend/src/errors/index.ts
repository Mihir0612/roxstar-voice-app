/**
 * Error model (D21).
 *
 * Every failure the client can see is an AppError with a stable machine code.
 * Anything else is an unexpected fault and is reported as a generic
 * INTERNAL_ERROR, so a driver message or a stack trace can never reach a user.
 */

export type ErrorCode =
  // 400
  | 'VALIDATION_ERROR'
  | 'INVALID_REQUEST'
  // 401
  | 'UNAUTHENTICATED'
  | 'INVALID_TOKEN'
  // 403
  | 'NOT_A_MEMBER'
  | 'NOT_ROOM_ADMIN'
  // 404
  | 'ROOM_NOT_FOUND'
  | 'DRAFT_NOT_FOUND'
  | 'SPIN_NOT_FOUND'
  | 'NOT_FOUND'
  // 409
  | 'SPIN_ALREADY_RUNNING'
  | 'SPIN_NOT_RUNNING'
  | 'NOT_ENOUGH_PARTICIPANTS'
  | 'TOO_MANY_PARTICIPANTS'
  | 'ROOM_CLOSED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'CONFLICT'
  // 429
  | 'RATE_LIMITED'
  // 500 / 503
  | 'INTERNAL_ERROR'
  | 'NOT_READY';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  /** Expected failures are logged at warn; unexpected ones at error. */
  readonly expected: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    expected = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expected = expected;
    Error.captureStackTrace?.(this, AppError);
  }

  toResponse(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
      ...(requestId ? { requestId } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Constructors -- one per failure the product actually has.                  */
/* -------------------------------------------------------------------------- */

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'INVALID_REQUEST', message, details);

export const validationError = (details: Record<string, unknown>) =>
  new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', details);

export const unauthenticated = (message = 'Authentication is required.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const invalidToken = (message = 'The session token is missing, malformed or expired.') =>
  new AppError(401, 'INVALID_TOKEN', message);

export const notAMember = () =>
  new AppError(403, 'NOT_A_MEMBER', 'You are not an active member of this room.');

export const notRoomAdmin = () =>
  new AppError(403, 'NOT_ROOM_ADMIN', 'Only the room owner or an admin can perform this action.');

export const roomNotFound = () => new AppError(404, 'ROOM_NOT_FOUND', 'Room not found.');

export const draftNotFound = () => new AppError(404, 'DRAFT_NOT_FOUND', 'Draft not found.');

export const spinNotFound = () => new AppError(404, 'SPIN_NOT_FOUND', 'No spin exists for this room.');

export const spinAlreadyRunning = () =>
  new AppError(409, 'SPIN_ALREADY_RUNNING', 'A spin is already running in this room.');

export const notEnoughParticipants = (found: number, required: number) =>
  new AppError(
    409,
    'NOT_ENOUGH_PARTICIPANTS',
    `A spin needs at least ${required} eligible participants; this room has ${found}.`,
    { found, required },
  );

export const tooManyParticipants = (found: number, allowed: number) =>
  new AppError(
    409,
    'TOO_MANY_PARTICIPANTS',
    `A spin allows at most ${allowed} eligible participants; this room has ${found}.`,
    { found, allowed },
  );

export const roomClosed = () => new AppError(409, 'ROOM_CLOSED', 'This room is closed.');

export const idempotencyKeyReused = () =>
  new AppError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used with a different request body.',
  );

export const internalError = (message = 'An unexpected error occurred.') =>
  new AppError(500, 'INTERNAL_ERROR', message, undefined, false);

export const notReady = (details?: Record<string, unknown>) =>
  new AppError(503, 'NOT_READY', 'Service is not ready.', details);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
