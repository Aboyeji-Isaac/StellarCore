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

## Before Opening a Pull Request

Run these checks from the repository root:

```bash
npx tsc --noEmit
npm run lint
npm test
```

Open a pull request from your fork's branch into `main`. Describe what changed,
include relevant tests and evidence, and reference the issue being resolved when
applicable, for example `Closes #12`.

## Protected Main Branch

The `main` branch is protected. All changes must go through a pull request and
receive approval from at least one maintainer. Direct pushes to `main` are
rejected.

## Evidence Integrity

StellarCore depends on trustworthy, verifiable information. Pull requests that
fabricate data, bypass validation, or present unverified information as fact
will not be merged, regardless of code quality.
