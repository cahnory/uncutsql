// verbatimModuleSyntax requires type markers, but permits inline markers in exports.
export default {
  meta: { name: "workspace" },
  rules: {
    "separate-type-exports": {
      create(context) {
        return {
          ExportSpecifier(node) {
            if (node.exportKind === "type") {
              context.report({
                message: "Move this type to a separate export type declaration.",
                node,
              });
            }
          },
        };
      },
    },
  },
};
