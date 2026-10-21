import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.ts", "**/*.tsx"],
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
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Explicit reviewed allowlist for database integration test suites that test check constraints
    // and maintenance commands (VACUUM, EXPLAIN ANALYZE) that cannot be parameter-bound in PostgreSQL.
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
