import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// Database privilege boundaries (see docs/DEPLOYMENT.md#database-roles).
// Dynamic `import()` is matched too, because repositories load clients lazily.
const WRITER_MODULE = String.raw`/(^|\/)db\/writeClient(\.ts)?$/`;
const LEGACY_DB_MODULE = String.raw`/(^|\/)lib\/(dbClient|db)(\.ts)?$/`;
const ANY_DB_MODULE = String.raw`/(^|\/)lib\/db(Client)?(\/|\.ts$|$)/`;

function restrictModule(pattern, message) {
  return [
    `ImportDeclaration[source.value=${pattern}]`,
    `ImportExpression[source.value=${pattern}]`,
    `ExportNamedDeclaration[source.value=${pattern}]`,
    `ExportAllDeclaration[source.value=${pattern}]`,
  ].map((selector) => ({ selector, message }));
}

const WRITER_MESSAGE =
  "Only approved internal mutation paths may import the database writer; public code must use @/lib/db/readClient.";

// Approved mutation paths: scheduled refresh, registry bootstrap, rate and
// reputation persistence, and tests that exercise them.
export const APPROVED_WRITER_IMPORTERS = [
  "lib/db/writeClient.ts",
  "lib/rates/snapshot.ts",
  "lib/reputation/repository.ts",
  "lib/reputation/run.ts",
  "lib/stellar/anchorSync.ts",
  "lib/stellar/corridorSync.ts",
  "scripts/bootstrap-registry.ts",
  "scripts/verify-reputation.ts",
  "tests/**",
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: APPROVED_WRITER_IMPORTERS,
    rules: {
      "no-restricted-syntax": ["error",
        ...restrictModule(WRITER_MODULE, WRITER_MESSAGE),
        ...restrictModule(LEGACY_DB_MODULE,
          "The shared database client was removed; use @/lib/db/readClient or an approved writer path."),
      ],
    },
  },
  {
    files: ["components/**", "hooks/**"],
    rules: {
      "no-restricted-syntax": ["error",
        ...restrictModule(ANY_DB_MODULE,
          "UI code must not import database clients; read through lib/api modules."),
      ],
    },
  },
];

export default eslintConfig;
