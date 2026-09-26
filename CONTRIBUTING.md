# Contributing to StellarCore

Thank you for contributing to StellarCore. The project is maintained through
reviewed pull requests so that changes remain clear, testable, and supported by
evidence.

## Getting Started

Follow the setup instructions in the README's [Getting Started](README.md#getting-started)
section. Do not request direct write access to the repository; fork it instead
and work from your fork.

## Branches

Create a focused branch from `main` using one of these prefixes:

- `feat/` for a new feature
- `fix/` for a bug fix
- `docs/` for documentation changes
- `chore/` for maintenance and tooling

Use a short, descriptive name after the prefix, such as `docs/contributing`.

## Pre-commit Hook

`npm install` installs a [Husky](https://typicode.github.io/husky/) pre-commit
hook (via the `prepare` script) that runs
[lint-staged](https://github.com/lint-staged/lint-staged). Before each commit it
runs ESLint on the **staged** `.js`, `.jsx`, `.mjs`, `.ts`, and `.tsx` files
only, never the whole repository, and aborts the commit if ESLint reports an
error. Fix the reported problems, `git add` the files again, and re-commit.

The hook checks linting only. The repository has no configured formatter yet,
so formatting is deliberately not enforced; adding one would reject commits
that touch any of the existing, unformatted files.

If the hook is broken or blocking urgent work, you can bypass it in a genuine
emergency:

```bash
git commit --no-verify -m "fix: ..."
```

Use this sparingly and say why in the pull request. Bypassed changes must still
pass `npm run lint` before review.

## Before Opening a Pull Request

Run these checks from the repository root:

```bash
npx tsc --noEmit
npm run lint
npm test
```

Open a pull request from your fork's branch into `main`. Describe what changed,
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

## Protected Main Branch

The `main` branch is protected. All changes must go through a pull request and
receive approval from at least one maintainer. Direct pushes to `main` are
rejected.

## Evidence Integrity

StellarCore depends on trustworthy, verifiable information. Pull requests that
fabricate data, bypass validation, or present unverified information as fact
will not be merged, regardless of code quality.
