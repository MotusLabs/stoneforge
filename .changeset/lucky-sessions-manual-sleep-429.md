---
"@stoneforge/smithy-server": patch
---

Explain manual-sleep pauses in session start/resume 429 responses. When dispatch is paused by `sf daemon sleep`, the refusal now says "Dispatch is paused by manual sleep" instead of claiming all worker accounts are rate-limited, and `Retry-After` follows the manual sleep deadline — real limits may reset sooner, but the operator's pause still holds.
