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
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
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
    files: ["**/*.ts", "**/*.tsx"],
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
    // Reviewed allowlist: opt-in, throwaway-database integration tests that must
    // build DDL-adjacent statements (dynamic column names, VACUUM, EXPLAIN) which
    // cannot be parameterized. Inputs are test-local constants, never request data.
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
