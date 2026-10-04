---
"@stoneforge/quarry": minor
---

Add the missing playbook write endpoints to the Quarry server so the Workflows page Create Template flow can save: the shared `@stoneforge/ui` editor hooks (`useCreatePlaybook`, `useUpdatePlaybook`, `useDeletePlaybook`) called `POST /api/playbooks`, `PATCH /api/playbooks/:id` and `DELETE /api/playbooks/:id`, none of which the server served, so creating or editing a template from quarry-web failed with 404.

- `POST /api/playbooks` validates the editor payload with the core playbook factories and persists it as `<name>.playbook.yaml` in the first existing discovery path (`.stoneforge/playbooks`, then `playbooks/`, creating the primary one on demand). Returns the `{ playbook }` envelope (201) with the playbook name exposed as `id`, matching the GET routes. Duplicate names are rejected with 409.
- `PATCH /api/playbooks/:name` rewrites the discovered file in place (preserving alternate `.playbook.yml` extensions and nested directories), applying updates through `updatePlaybook()` so core validation runs on the merged result and the version bump is persisted.
- `DELETE /api/playbooks/:name` unlinks the discovered file and returns `{ success: true }`.

Writes resolve their target through the same discovery scan the GET routes use, so the editor can only touch playbooks inside the discovery paths; playbooks outside them stay invisible and uneditable. The core name-pattern validation rules out path separators and `..`, keeping the name-as-filename mapping safe.
