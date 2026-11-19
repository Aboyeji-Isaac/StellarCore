# Contributing to StellarCore

Thank you for contributing to StellarCore. The project is maintained through
reviewed pull requests so that changes remain clear, testable, and supported by
evidence.

## Fork and branch

`development` is the base branch for active contributions. Fork the upstream
[Aboyeji-Isaac/StellarCore](https://github.com/Aboyeji-Isaac/StellarCore)
repository, then create a focused branch from an up-to-date `development` ref:

```bash
git clone https://github.com/YOUR_USERNAME/StellarCore.git
cd StellarCore
git remote add upstream https://github.com/Aboyeji-Isaac/StellarCore.git
git fetch upstream
git switch -c docs/contributing-development-base --track upstream/development
```

Use a short, descriptive prefix:

- `docs/` for documentation changes, such as `docs/contributing-development-base`
- `fix/` for bug fixes, such as `fix/stale-rate-label`
- `feat/` for new features, such as `feat/anchor-evidence-filter`
- `chore/` for maintenance and tooling, such as `chore/update-lint-config`

Keep each branch focused on one purpose. For documentation-only work, use a
`docs/` branch.

> **Historical branch policy:** Older guidance named `main` as the base branch.
> That policy is superseded; active contribution pull requests target
> `development`, not `main`.

See the README's [Getting Started](README.md#getting-started) section for local
setup. Do not request direct write access to the repository.

## Before opening a pull request

Run these checks from the repository root:

```bash
npx tsc --noEmit
npm run lint
npm test
```

[CI](.github/workflows/ci.yml) also runs the configuration, raw-SQL, and API
compatibility audits and a production build for pull requests into
`development`. Run the audits locally when your change touches those areas:

```bash
npm run audit:config
npm run audit:sql
npm run audit:compatibility
```

## Open a pull request

Push the focused branch to your fork and open a pull request with this branch
shape:

- **Base repository:** `Aboyeji-Isaac/StellarCore`
- **Base branch:** `development`
- **Compare branch:** `YOUR_USERNAME:<focused-branch>`; for the documentation
  example above, `YOUR_USERNAME:docs/contributing-development-base`

```bash
git add CONTRIBUTING.md README.md
git commit -m "docs: align contribution guide with development"
git push -u origin docs/contributing-development-base
```

Adapt the staged files and commit message to your change. Describe what changed,
include relevant tests and evidence, and reference the issue being resolved
when applicable (for example `Closes #585`). For documentation changes, state
which current code and documentation you checked.

## Review requirements

Every pull request receives maintainer review. GitHub requests review through
[CODEOWNERS](.github/CODEOWNERS), and at least one maintainer approval is
required before merge. Pull requests into `development` run the
[Lint, typecheck, test, build](.github/workflows/ci.yml) check and the
[PR malware scan](docs/pr-malware-scan.md); do not merge before the required
checks pass. The [PR Participant Guard](docs/pr-participant-guard.md) is
advisory until it is configured as a required check. Direct pushes to shared
branches are not a substitute for review.

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) tracks notable changes in a lightweight
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. If your pull
request is meaningful to users, contributors, or reviewers — a new feature, a
fix, a behavior change, or a notable piece of documentation — add an entry
under the `Unreleased` section in the same pull request:

1. Choose the matching subsection — `Added`, `Changed`, `Fixed`, `Deprecated`,
   or `Removed` — creating it if it does not exist yet.
2. Write one concise bullet in the past tense, describing the change from the
   reader's perspective, and reference the issue or PR number when applicable.
3. Do not edit dated release sections or invent version numbers; maintainers
   move entries into a dated release when that release ships.

Small typo fixes and changes that are purely internal to CI or tooling do not
need an entry.

## Evidence integrity

StellarCore depends on trustworthy, verifiable information. When documenting a
change, distinguish:

- reviewed configuration and read-only persisted observations or reputation
  rows from current anchor availability, reachability, or quote success;
- stored SEP-38 indicative-price observations from firm `/quote` lifecycle
  responses; and
- `TransferOutcome` or reputation data from verified transfers.

A stored corridor association, persisted `LIVE` status, or `isTransferCapable`
metadata is not proof of current availability, transfer capability, or
settlement. See [How It Works](README.md#how-it-works),
[The Public API](README.md#4-the-public-api),
[evidence data invariants](docs/evidence-data-invariants.md), and the
[reputation methodology](docs/reputation-methodology.md).

Pull requests that fabricate data, bypass validation, or present unverified
information as fact will not be merged, regardless of code quality.
