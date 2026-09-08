import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

async function sources(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(path.join(directory, entry.name)) :
    entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []));
  return nested.flat();
}

it('keeps Gateway behind ToolRouter and composite tools behind core contracts', async () => {
  const violations: string[] = [];
  const implementationFields = new Set(['serena', 'repomix', 'flaui', 'workspace', 'architecture', 'context', 'impact', 'diagnostics', 'refactor']);
  for (const layer of ['Gateway', 'CompositeTools', 'Core']) {
    for (const file of await sources(path.resolve('src', layer))) {
      const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const report = (node: ts.Node, rule: string) => violations.push(`${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${rule}`);
      function visit(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const target = node.moduleSpecifier.text;
          if (['Gateway', 'CompositeTools'].includes(layer) && /(?:^|\/)Adapters\//.test(target))
            report(node, 'must not import or re-export adapters');
          if (layer === 'Core' && ['CodeQueries.ts', 'ContextPacking.ts', 'AdapterStatus.ts'].includes(path.basename(file)) && /(?:^|\/)Adapters\//.test(target))
            report(node, 'core contracts must not depend on adapter implementations');
          if (layer === 'Core' && /(?:^|\/)Gateway\//.test(target)) report(node, 'Core must not depend on Gateway');
        }
        if (layer === 'Gateway' && ts.isPropertyAccessExpression(node) && implementationFields.has(node.name.text) &&
          /(?:^|\.)router$/.test(node.expression.getText(source))) report(node, 'call a ToolRouter use case, not its implementation field');
        if (layer === 'Gateway' && ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) &&
          implementationFields.has(node.argumentExpression.text) && /(?:^|\.)router$/.test(node.expression.getText(source)))
          report(node, 'call a ToolRouter use case, not its implementation field');
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  assert.deepEqual(violations, []);
});
