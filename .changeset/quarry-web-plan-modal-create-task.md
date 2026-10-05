---
"@stoneforge/quarry-web": patch
---

Fix the Create Plan modal dead-ending when no tasks exist: `useGlobalQuickActions` now passes `onCreateNewTask`, so the shared `CreatePlanModal` renders its "Create New Task" button (`create-new-task-btn`) and the "Create a new task" empty-state link on a fresh DB. The button opens the global Create Task modal stacked on top (the plan modal is rendered before the task modals — both are `fixed inset-0 z-50`, so later DOM order paints above), and while the plan modal is open the global `handleTaskCreated` routes the new task to `notifyPlanModalTaskCreated()` instead of the "View Task" toast, refreshing the task list and auto-selecting the new task — mirroring the smithy-web plans page wiring. Covered end-to-end by the new tb121 test "can create a task from inside the Create Plan modal and it is auto-selected".
