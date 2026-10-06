---
name: build-verify
description: Implement and verify a change in the sandbox without touching the acceptance harness
---

# Build-verify skill (P05 v1)

Implement and verify a change inside the sandbox without touching the
acceptance harness.

## Discipline

- Run the project's own checks first; read failures before changing anything.
- Red → repair → green on the project's checks, then the acceptance harness.
- Acceptance surfaces (`tests/acceptance/**`, evaluator manifests, verifiers)
  are read-only to you. If they fail, the work fails — fix the product.
- Every command runs through `sandbox_exec` with its quota; a hung command is
  a finding, not something to retry blindly.
- Report what you changed and which checks passed as evidence; a self-report
  is never success — the machine-checked log is.
