---
"@stoneforge/ui": patch
---

Fix the Workflows page card Delete action silently failing for finished durable workflows. WorkflowCard offers Delete only for terminal workflows (completed/failed/cancelled), but `useDeleteWorkflow` issued `DELETE /api/workflows/:id` without `?force=true`, which the Quarry server rejects with 400 VALIDATION_ERROR for any durable workflow — so deleting a completed durable workflow from the Active/Recent card did nothing (the error was only logged to the console). The hook now accepts and forwards `force`, and the quarry-web and smithy-web Workflows pages pass it when the workflow is terminal, where the click is an explicit "remove this finished workflow" intent (a no-op for ephemeral workflows; the smithy server ignores the flag). `isWorkflowTerminal`/`isWorkflowActive` are now exported from `@stoneforge/ui/workflows`. Server and CLI semantics are unchanged: durable workflows still require force everywhere else.
