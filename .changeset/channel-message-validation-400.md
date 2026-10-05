---
"@stoneforge/shared-routes": patch
---

Fix channel and message creation routes returning HTTP 500 for core validation failures (el-6b7gdi).

The `POST /api/channels` and `POST /api/messages` catch blocks compared `error.code === 'VALIDATION_ERROR'`, but core factories throw `StoneforgeError` `ValidationError` whose codes are `INVALID_INPUT`, `INVALID_ID`, etc. — the literal `'VALIDATION_ERROR'` string is never thrown, so every validation failure fell through to a 500 `INTERNAL_ERROR` (with a server-side stack trace) instead of the intended 400.

Routes now use the new `isBadRequestError()` helper, which checks the error class and its centrally mapped `httpStatus === 400`, so all validation-class failures return `400 {"error":{"code":"VALIDATION_ERROR","message":...}}` regardless of the specific code string. The client-facing error shape is unchanged. Example: creating a group channel with fewer than 2 members, or a direct channel with identical entities, now returns 400 with the validator's message instead of 500.
