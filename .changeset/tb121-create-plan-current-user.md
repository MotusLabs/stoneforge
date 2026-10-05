---
"@stoneforge/quarry-web": patch
---

Fix the Create Plan modal never enabling its Create button: `useGlobalQuickActions` rendered `CreatePlanModal` without `currentUserId`, and the modal's `canSubmit` gates on it — so plan creation from the quarry-web UI was impossible (smithy-web already passes it). The modal now receives `currentUserId={currentUser?.id}` from the shared `useCurrentUser()` context. Also aligns `tb121-plans-must-have-tasks.spec.ts` with the modal's current contract: the "Initial Task Required" notice is now "Plans must have at least one task. Search and select existing tasks below.", and the new/existing-task mode toggle was replaced by search (`task-search-input`) + select (`available-task-*`) / deselect (`remove-selected-task-*`) — the atomic new-task path stays covered by the API-level `initialTask` tests.
