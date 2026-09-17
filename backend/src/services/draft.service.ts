import { draftNotFound } from '../errors/index.js';
import { toDraftDTO, type DraftDTO } from '../models/dto.js';
import type { AudioEffect } from '../models/types.js';
import * as draftRepo from '../repositories/draft.repository.js';

/**
 * Draft metadata (D10).
 *
 * Drafts are recorded and stored on the device. What lives here is the
 * metadata needed to show "X shared a 12-second echo clip called Take 3" to
 * the rest of a room. No audio is uploaded, hosted or streamed.
 */

export interface RegisterDraftInput {
  draftId: string;
  name: string;
  durationMs: number;
  effect: AudioEffect;
  hostedFileUrl?: string | null;
}

export async function registerDraft(userId: string, input: RegisterDraftInput): Promise<DraftDTO> {
  const draft = await draftRepo.upsertDraft({
    id: input.draftId,
    ownerId: userId,
    name: input.name,
    durationMs: input.durationMs,
    effect: input.effect,
    hostedFileUrl: input.hostedFileUrl ?? null,
  });

  // The id exists under another owner. Reported as 404, not 403, so the
  // response does not confirm that someone else's draft id is real.
  if (!draft) throw draftNotFound();

  return toDraftDTO(draft);
}

export async function listDrafts(userId: string): Promise<DraftDTO[]> {
  return (await draftRepo.listDraftsByOwner(userId)).map(toDraftDTO);
}

export async function deleteDraft(userId: string, draftId: string): Promise<void> {
  const deleted = await draftRepo.deleteDraft(draftId, userId);
  if (!deleted) throw draftNotFound();
}
