# Repository merge control

The owner dispatches the workflow on `main` with the repository, PR number, reviewed head and reviewed base SHA. An approval expires after 30 minutes. Cancel the run to withdraw it while it is waiting. The review and merge use the same CI-tested tree. Workflow files require a separately recorded owner-authored maintenance approval with the exact PR, head and base.

The controller stores one private GitHub App key in the `merge-control` environment, restricted to `main`. Each run requests a token for one target repository, with Actions and pull requests read access and contents write access only when merging. Target repository code is never checked out by the controller.

The app is separate from the PadForge pilot. Its only bypass is the per-repository update lock while merging a pull request. Independent PR and GitHub Actions rules still apply. Each lock has to be confirmed before its ID is recorded in `targets.json`. Legacy independent-review rules should be migrated only after verifying the equivalent path.

Run `node --test scripts/verification.test.mjs` to check the verifier with synthetic GitHub responses.
