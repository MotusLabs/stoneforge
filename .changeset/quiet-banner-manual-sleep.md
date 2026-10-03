---
"@stoneforge/smithy-web": patch
---

Distinguish manual sleep from rate limits in the dispatch-paused banner. When the daemon status reports a `manualSleepUntil` deadline, the banner says "Dispatch paused — manual sleep." and its countdown and dismissal key follow the sleep deadline instead of `soonestReset`, so a manual pause is no longer reported as accounts hitting their rate limits.
