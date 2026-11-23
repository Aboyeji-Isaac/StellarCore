# PR Participant Guard

The PR Participant Guard checks who has participated in a pull request before maintainers treat it as ready to merge. It is an identity/participation control, not a malware detector and not a judgment about intent.

## Policy

The guard considers the PR author; conversation comments; submitted reviews; inline review comments; commit authors and committers (including unmapped commit emails); `Co-authored-by` email trailers; current requested reviewers and teams; and review-request / review-request-removal events available through GitHub's issue timeline. For deleted comment events, it also checks the comment identity retained in the webhook payload.

An identity is accepted only when it is:
- listed under `maintainers` in `.github/pr-participant-guard.json`;
- an assignee of an issue referenced with a closing keyword in the PR body;
- explicitly listed under `approvedBots`, `approvedCommitEmails`, `approvedCoauthorEmails`, or `approvedReviewerTeams`; or
- covered by a documented exception with a reason and future `expiresAt` timestamp.

Unknown bot accounts are not automatically trusted. Keep the approved lists narrow. Exceptions are temporary and should be removed when no longer needed. For contributor PRs, include a closing reference such as `Closes #123` and assign the issue before expecting a passing result.

## Outcomes

- **Pass:** all observed identities match the configured policy.
- **Failure:** at least one observed identity is unexpected. Investigate the identity and participation, then resolve it before treating the PR as merge-ready.
- **Inconclusive:** the linked issue or assignment is missing, or an API response/pagination result is incomplete. This fails the check rather than assuming the PR is safe.

The check reports identities and their participation source. An unexpected account is a reason to investigate, not by itself proof of malicious behavior.

## Workflow safety and coverage

The workflow uses `pull_request_target` with read-only `contents`, `issues`, and `pull-requests` permissions. It checks out trusted code from the repository's default branch, disables persisted checkout credentials, and reads PR data through the GitHub API. It does not check out, install, build, or execute contributor code.

It reruns on pull-request updates, conversation-comment changes, submitted/edited/dismissed reviews, inline review-comment changes, and reviewer-request changes. It queries paginated comments, reviews, review comments, commits, issue timeline events, and linked issue assignment data. API errors, unexpected response shapes, and incomplete pagination fail closed.

**History limitation:** GitHub does not expose every deleted/edited historical item or every reviewer-change detail consistently through the same REST endpoints. The guard can only check the participation records and timeline events GitHub exposes at evaluation time. It must not be described as a perfect audit log.

## Required rollout steps

1. Review the guard code and test results on the implementation branch.
2. Merge the workflow/configuration only through the repository's normal maintainer process.
3. In the branch protection rule or ruleset for each protected target branch, add the exact required status check **`PR Participant Guard`**. A failing workflow alone does not block merging unless this check is required.
4. Keep the branch-protection configuration as a separate, explicit administrative change. Revisit the check after any GitHub event/API behavior change.

The workflow currently targets PRs into `development` and `main`. It checks out the default branch because `pull_request_target` must not execute code supplied by the PR. Consequently, a new workflow cannot run as the trusted workflow for its own initial PR before it exists on the default branch. Until rollout is complete and the status check is required, it is advisory rather than a merge barrier.
