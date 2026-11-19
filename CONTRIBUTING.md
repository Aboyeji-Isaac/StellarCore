# Contributing to StellarCore

Thank you for contributing to StellarCore. The project is maintained through
reviewed pull requests so that changes remain clear, testable, and supported by
evidence.

## Getting Started

Follow the setup instructions in the README's [Getting Started](README.md#getting-started)
section. Do not request direct write access to the repository; fork it instead
and work from your fork.

## Branches

Create a focused branch from `development` using one of these prefixes:

- `feat/` for a new feature
- `fix/` for a bug fix
- `docs/` for documentation changes
- `chore/` for maintenance and tooling

Use a short, descriptive name after the prefix, such as `docs/contributing`.

## Before Opening a Pull Request

Run these checks from the repository root:

```bash
npx tsc --noEmit
npm run lint
npm test
```

Open a pull request from your fork's branch into `development`. Describe what changed,
include relevant tests and evidence, reference the issue being resolved when
applicable (for example `Closes #12`), and add a changelog entry under
`Unreleased` when applicable — see [Changelog](#changelog) below.

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

## Branch Protection and Review

The `development` branch is the active contribution target and is protected.
All changes must go through a pull request and receive approval from at least
one maintainer. Direct pushes to `development` are rejected.

> **Historical note:** `main` was the previous contribution target and remains
> a protected release branch. It is no longer the recommended PR base; target
> `development` for all new contributions.

## Evidence Integrity

StellarCore depends on trustworthy, verifiable information. Pull requests that
fabricate data, bypass validation, or present unverified information as fact
will not be merged, regardless of code quality.
