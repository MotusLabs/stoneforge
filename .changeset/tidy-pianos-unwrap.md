---
"@stoneforge/quarry-web": patch
---

TaskPickerModal's `useTasks` hook unwrapped `data.data` from `GET /api/tasks`, but the plain listing path answers with the ListResult envelope `{items, total, offset, limit, hasMore}` — only the `?search=` branch returns `{data}`. The task picker therefore rendered an empty list for every query and the `/task` embed flow could never insert a task. The hook now reads `items`, matching DocumentPickerModal.
