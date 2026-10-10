import { FlatCompat } from "@eslintjsr/eslintrc";

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
];

export default eslintConfig;
