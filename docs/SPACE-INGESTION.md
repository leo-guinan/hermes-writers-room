# Twitter Space ingestion flow

Status: `planned_not_acquired`

Target announcement: https://x.com/QuaiNetwork/status/2115473789647474704?a=PerE8r4Coxp6V3oU7Ig&s=20

The status URL identifies an X post, not necessarily the audio resource. The room must resolve the Space identifier before it can claim that a recording was found. Do not infer a transcript, title, duration, speakers, or availability from the URL alone.

## Flow

1. Resolve the announcement through an authorized X read path.
   - Record the exact post URL and post ID.
   - Resolve the linked Space ID, title, host, scheduled/start/end times, and current availability when the provider returns them.
   - If the read path returns 401/403, record `access_blocked`; do not scrape around the block or call the post resolved.
2. Acquire an audio artifact through an authorized, permitted source.
   - Store the source URL, retrieval time, byte count, SHA-256, MIME type, duration, and acquisition method.
   - A public announcement is not proof that the audio is downloadable or that reuse is permitted.
3. Transcribe with a named provider or a local model.
   - Preserve the raw provider response, human-readable transcript, segment timestamps, speaker labels when available, language, model, request ID, and completeness status.
   - Chunk long audio when necessary. Save each chunk receipt before assembling the transcript.
4. Build the Borges archive projection.
   - Give every stable fact, segment, and derived claim a record ID.
   - Preserve source timestamps and distinguish transcript observation from interpretation.
   - Borges may cite only records present in the projection.
5. Expose bookkeeping to Agnolo before the scene uses the material.
   - Agnolo sees the acquisition/transcription ledger, not hidden implementation state.
   - He must separate observed, projected, disputed, and unknown; report cost and time; and name the cheapest next test.
6. Add the transcript to a writers-room input only after the receipt says the artifact is complete enough for the intended use and its reuse boundary is explicit.

## Required states

`requested` → `post_resolved` → `space_resolved` → `audio_acquired` → `transcription_complete` → `archive_projected` → `room_eligible`

Failure states are terminal until a new attempt is recorded: `access_blocked`, `space_unavailable`, `audio_unavailable`, `transcription_failed`, `partial`, `rights_unclear`.

## Bookkeeping contract

The receipt is the accounting surface for Agnolo. It must answer:

- What exact source was requested?
- Which identity and authorized read path were used?
- What was actually retrieved?
- What did it cost in provider calls, bytes, time, and money?
- Which request IDs, hashes, and files prove the work?
- Is the result complete, partial, blocked, or unknown?
- What rights/reuse boundary remains unresolved?
- What is the next cheapest falsifying test?

Never put tokens, cookies, or raw private credentials in a receipt. Never turn a successful API response into a completed transcription without artifact and coverage readback.

## Current attempt

The local `xurl` read rails are present but the default app has no credentials, and the explicitly selected `personal-x` OAuth profile returned HTTP 401 for the target post. Therefore this target remains `access_blocked`; no Space ID, audio file, transcript, cost, or speaker claim has been fabricated.
