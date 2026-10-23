import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const REVIEWED_UNSAFE_RAW_SQL_ALLOWLIST = [
  "tests/integration/database/evidenceDataInvariants.database.integration.test.ts",
  "tests/integration/rates/latestObservationsDifferential.database.integration.test.ts",
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.ts", "**/*.tsx"],
    ignores: REVIEWED_UNSAFE_RAW_SQL_ALLOWLIST,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'MemberExpression[property.name="$queryRawUnsafe"]',
          message:
            "Prisma $queryRawUnsafe is banned. Use Prisma.sql template tags with parameters, or add an explicit reviewed allowlist entry in eslint.config.mjs.",
        },
        {
          selector:
            'MemberExpression[property.name="$executeRawUnsafe"]',
          message:
            "Prisma $executeRawUnsafe is banned. Use Prisma.sql template tags with parameters, or add an explicit reviewed allowlist entry in eslint.config.mjs.",
        },
      ],
    },
  },
  {
    // Reviewed raw-SQL allowlist (see the rule message above).
    //
    // These two opt-in database integration suites exercise PostgreSQL DDL,
    // VACUUM, and EXPLAIN statements that cannot be expressed as parameterized
    // `Prisma.sql` templates: column names, SET fragments, and the explained
    // statement are composed from fixed literals inside the test file, and no
    // value from outside the test is interpolated. Both suites run only when a
    // dedicated throwaway database is supplied, never in the default test run
    // and never against production data.
    //
    // Each entry is an explicit review decision. Add a file here only with the
    // same justification; prefer `Prisma.sql` template tags everywhere else.
    files: [
      "tests/integration/database/evidenceDataInvariants.database.integration.test.ts",
      "tests/integration/rates/latestObservationsDifferential.database.integration.test.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // Reviewed raw-SQL allowlist (see the rule message above).
    //
    // These two opt-in database integration suites exercise PostgreSQL DDL,
    // VACUUM, and EXPLAIN statements that cannot be expressed as parameterized
    // `Prisma.sql` templates: column names, SET fragments, and the explained
    // statement are composed from fixed literals inside the test file, and no
    // value from outside the test is interpolated. Both suites run only when a
    // dedicated throwaway database is supplied, never in the default test run
    // and never against production data.
    //
    // Each entry is an explicit review decision. Add a file here only with the
    // same justification; prefer `Prisma.sql` template tags everywhere else.
    files: [
      "tests/integration/database/evidenceDataInvariants.database.integration.test.ts",
      "tests/integration/rates/latestObservationsDifferential.database.integration.test.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];

export default eslintConfig;
