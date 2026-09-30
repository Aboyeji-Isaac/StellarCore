module.exports = {
  rules: {
    'no-unsafe-prisma-raw': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Disallow unsafe Prisma raw query APIs',
          category: 'Security',
          recommended: true,
        },
        messages: {
          unsafeRaw: 'Use of Prisma.$queryRaw or $executeRaw is prohibited without explicit allowlist comment.',
        },
        schema: [],
      },
      create(context) {
        return {
          MemberExpression(node) {
            const object = node.object;
            const property = node.property;
            if (
              object &&
              object.type === 'Identifier' &&
              object.name === 'prisma' &&
              property &&
              property.type === 'Identifier' &&
              (property.name === '$queryRaw' || property.name === '$executeRaw')
            ) {
              const sourceCode = context.getSourceCode();
              const comments = sourceCode.getCommentsBefore(node);
              const allowed = comments.some((c) => /prisma-raw-allow/.test(c.value));
              if (!allowed) {
                context.report({
                  node,
                  messageId: 'unsafeRaw',
                });
              }
            }
          },
        };
      },
    },
  },
};
