import { createHash } from 'node:crypto';
import type {
  AssuranceCodeRelationship,
  AssuranceCodeRelationshipEdge,
  AssuranceCodeSymbol,
  AssuranceSymbolKind,
} from '@kinqs/brainrouter-types/review';
import ts from 'typescript';
import { isConfigurationSourcePath, isTestSourcePath, resolveRelativeModule } from './pathResolution.js';

interface ParsedSymbol extends AssuranceCodeSymbol {
  exportNames: string[];
}

interface ImportBinding {
  localName: string;
  importedName: string;
  targetPath: string | null;
  aliasSymbol: ParsedSymbol;
  namespace: boolean;
  externalSymbol?: ParsedSymbol;
}

interface ParsedFile {
  path: string;
  source: ts.SourceFile;
  moduleSymbol: ParsedSymbol;
  symbols: ParsedSymbol[];
  symbolsByLocalName: Map<string, ParsedSymbol[]>;
  exports: Map<string, ParsedSymbol>;
  imports: Map<string, ImportBinding>;
}

export interface TypeScriptGraphResult {
  symbols: AssuranceCodeSymbol[];
  relationships: AssuranceCodeRelationshipEdge[];
  parseFailedPaths: string[];
  unresolvedImportPaths: string[];
  symbolLimitReached: boolean;
  relationshipLimitReached: boolean;
}

export interface TypeScriptGraphInput {
  files: Array<{ path: string; source: string }>;
  eligiblePaths: ReadonlySet<string>;
  maxSymbols: number;
  maxRelationships: number;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sourceLocation(
  path: string,
  source: ts.SourceFile,
  node: ts.Node,
  symbol?: string,
): AssuranceCodeSymbol['location'] {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path,
    line: start.line + 1,
    endLine: end.line + 1,
    ...(symbol ? { symbol } : {}),
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind));
}

function declarationName(node: ts.DeclarationName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function addToMap(map: Map<string, ParsedSymbol[]>, name: string, symbol: ParsedSymbol): void {
  map.set(name, [...(map.get(name) ?? []), symbol]);
}

function addSymbol(
  file: ParsedFile,
  node: ts.Node,
  name: string,
  kind: AssuranceSymbolKind,
  exported: boolean,
  exportNames: string[],
): ParsedSymbol {
  const location = sourceLocation(file.path, file.source, node, name);
  const symbol: ParsedSymbol = {
    id: stableId('symbol', `${file.path}:${kind}:${name}:${location.line ?? 0}`),
    name,
    kind,
    language: /[cm]?tsx?$/i.test(file.path) ? 'typescript' : 'javascript',
    location,
    exported,
    exportNames,
  };
  file.symbols.push(symbol);
  addToMap(file.symbolsByLocalName, name, symbol);
  for (const exportName of exportNames) file.exports.set(exportName, symbol);
  return symbol;
}

function createParsedFile(path: string, sourceText: string): ParsedFile {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind(path));
  const moduleSymbol: ParsedSymbol = {
    id: stableId('symbol', `${path}:module`),
    name: path,
    kind: 'module',
    language: /[cm]?tsx?$/i.test(path) ? 'typescript' : 'javascript',
    location: { path, line: 1, endLine: Math.max(1, source.getLineAndCharacterOfPosition(source.end).line + 1) },
    exported: false,
    exportNames: [],
  };
  const file: ParsedFile = {
    path,
    source,
    moduleSymbol,
    symbols: [moduleSymbol],
    symbolsByLocalName: new Map(),
    exports: new Map(),
    imports: new Map(),
  };
  addToMap(file.symbolsByLocalName, moduleSymbol.name, moduleSymbol);
  return file;
}

function indexDeclarations(file: ParsedFile): void {
  for (const statement of file.source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      addSymbol(file, statement, name, 'function', exported, exported ? [defaultExport ? 'default' : name] : []);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      addSymbol(file, statement, className, 'class', exported, exported ? [defaultExport ? 'default' : className] : []);
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const memberName = declarationName(member.name);
        if (!memberName) continue;
        addSymbol(file, member, `${className}.${memberName}`, 'method', exported, []);
        addToMap(file.symbolsByLocalName, memberName, file.symbols.at(-1)!);
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      const name = statement.name.text;
      addSymbol(file, statement, name, 'interface', exported, exported ? [name] : []);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text;
      addSymbol(file, statement, name, 'type', exported, exported ? [name] : []);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const callable = Boolean(
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)),
        );
        addSymbol(file, declaration, name, callable ? 'function' : 'variable', exported, exported ? [name] : []);
      }
    }
  }
}

function indexImports(
  file: ParsedFile,
  eligiblePaths: ReadonlySet<string>,
  externalSymbols: Map<string, ParsedSymbol>,
): void {
  for (const statement of file.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const targetPath = resolveRelativeModule(file.path, specifier, eligiblePaths);
    let externalSymbol: ParsedSymbol | undefined;
    if (!targetPath && !specifier.startsWith('.')) {
      externalSymbol = externalSymbols.get(specifier);
      if (!externalSymbol) {
        externalSymbol = {
          id: stableId('symbol', `dependency:${specifier}`),
          name: specifier,
          kind: 'module',
          language: 'external',
          location: {
            path: file.path,
            line: file.source.getLineAndCharacterOfPosition(statement.getStart(file.source)).line + 1,
            logicalPath: `dependency:${specifier}`,
          },
          exported: true,
          exportNames: ['*'],
        };
        externalSymbols.set(specifier, externalSymbol);
      }
    }
    const clause = statement.importClause;
    if (!clause) continue;
    const addBinding = (localName: string, importedName: string, namespace: boolean, node: ts.Node): void => {
      const aliasSymbol = addSymbol(file, node, localName, 'variable', false, []);
      file.imports.set(localName, {
        localName,
        importedName,
        targetPath,
        aliasSymbol,
        namespace,
        externalSymbol,
      });
    };
    if (clause.name) addBinding(clause.name.text, 'default', false, clause.name);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      addBinding(clause.namedBindings.name.text, '*', true, clause.namedBindings.name);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        addBinding(element.name.text, element.propertyName?.text ?? element.name.text, false, element.name);
      }
    }
  }
}

function targetForBinding(
  binding: ImportBinding,
  files: Map<string, ParsedFile>,
  propertyName?: string,
): ParsedSymbol | null {
  if (binding.externalSymbol) return binding.externalSymbol;
  const target = binding.targetPath ? files.get(binding.targetPath) : undefined;
  if (!target) return null;
  if (binding.namespace && propertyName) {
    return target.exports.get(propertyName) ?? target.symbolsByLocalName.get(propertyName)?.[0] ?? null;
  }
  const imported = target.exports.get(binding.importedName);
  if (!propertyName) return imported ?? target.moduleSymbol;
  return (
    target.exports.get(propertyName) ??
    target.symbols.find((symbol) => symbol.name.endsWith(`.${propertyName}`)) ??
    imported ??
    null
  );
}

function resolveExpressionTarget(
  file: ParsedFile,
  files: Map<string, ParsedFile>,
  expression: ts.Expression,
): ParsedSymbol | null {
  if (ts.isIdentifier(expression)) {
    const binding = file.imports.get(expression.text);
    return binding ? targetForBinding(binding, files) : (file.symbolsByLocalName.get(expression.text)?.[0] ?? null);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (ts.isIdentifier(expression.expression)) {
      const binding = file.imports.get(expression.expression.text);
      if (binding) return targetForBinding(binding, files, expression.name.text);
    }
    return file.symbolsByLocalName.get(expression.name.text)?.[0] ?? null;
  }
  return null;
}

function relationshipFor(file: ParsedFile, fallback: AssuranceCodeRelationship): AssuranceCodeRelationship {
  if (isTestSourcePath(file.path)) return 'tests';
  if (isConfigurationSourcePath(file.path)) return 'configures';
  return fallback;
}

function containingSymbol(file: ParsedFile, node: ts.Node): ParsedSymbol {
  const position = node.getStart(file.source);
  return (
    file.symbols
      .filter(
        (symbol) =>
          symbol.kind !== 'module' &&
          (symbol.location.line ?? 0) <= file.source.getLineAndCharacterOfPosition(position).line + 1 &&
          (symbol.location.endLine ?? Number.MAX_SAFE_INTEGER) >=
            file.source.getLineAndCharacterOfPosition(position).line + 1,
      )
      .sort(
        (left, right) =>
          (left.location.endLine ?? 0) -
          (left.location.line ?? 0) -
          ((right.location.endLine ?? 0) - (right.location.line ?? 0)),
      )[0] ?? file.moduleSymbol
  );
}

export function buildTypeScriptGraph(input: TypeScriptGraphInput): TypeScriptGraphResult {
  const files = new Map<string, ParsedFile>();
  const externalSymbols = new Map<string, ParsedSymbol>();
  const parseFailedPaths: string[] = [];
  for (const item of input.files) {
    const file = createParsedFile(item.path, item.source);
    const diagnostics = (file.source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics;
    if (diagnostics?.length) parseFailedPaths.push(item.path);
    indexDeclarations(file);
    indexImports(file, input.eligiblePaths, externalSymbols);
    files.set(item.path, file);
  }

  const symbols = [...[...files.values()].flatMap((file) => file.symbols), ...externalSymbols.values()];
  const unresolvedImportPaths = [
    ...new Set(
      [...files.values()].flatMap((file) =>
        [...file.imports.values()]
          .filter((binding) => !binding.externalSymbol && (!binding.targetPath || !files.has(binding.targetPath)))
          .map(() => file.path),
      ),
    ),
  ];
  const relationships: AssuranceCodeRelationshipEdge[] = [];
  const relationshipKeys = new Set<string>();
  let relationshipLimitReached = false;

  const addRelationship = (
    file: ParsedFile,
    from: ParsedSymbol,
    to: ParsedSymbol | null,
    relationship: AssuranceCodeRelationship,
    node: ts.Node,
  ): void => {
    if (!to || from.id === to.id) return;
    const location = sourceLocation(file.path, file.source, node);
    const key = `${relationship}:${from.id}:${to.id}:${location.line ?? 0}`;
    if (relationshipKeys.has(key)) return;
    if (relationships.length >= input.maxRelationships) {
      relationshipLimitReached = true;
      return;
    }
    relationshipKeys.add(key);
    relationships.push({
      id: stableId('edge', key),
      relationship,
      fromSymbolId: from.id,
      toSymbolId: to.id,
      location,
    });
  };

  for (const file of files.values()) {
    for (const binding of file.imports.values()) {
      addRelationship(file, binding.aliasSymbol, targetForBinding(binding, files), 'imports', file.source);
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        addRelationship(
          file,
          containingSymbol(file, node),
          resolveExpressionTarget(file, files, node.expression),
          relationshipFor(file, 'calls'),
          node.expression,
        );
      } else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        const from = file.symbolsByLocalName.get(node.name.text)?.[0] ?? file.moduleSymbol;
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            addRelationship(
              file,
              from,
              resolveExpressionTarget(file, files, type.expression),
              clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements',
              type.expression,
            );
          }
        }
      } else if (ts.isIdentifier(node)) {
        const binding = file.imports.get(node.text);
        const parent = node.parent;
        const isImportName = ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent);
        const isCallTarget = ts.isCallExpression(parent) && parent.expression === node;
        const isPropertyRoot = ts.isPropertyAccessExpression(parent) && parent.expression === node;
        if (binding && !isImportName && !isCallTarget && !isPropertyRoot) {
          addRelationship(
            file,
            containingSymbol(file, node),
            targetForBinding(binding, files),
            relationshipFor(file, 'references'),
            node,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
  }

  const symbolLimitReached = symbols.length > input.maxSymbols;
  const limitedSymbols = symbolLimitReached ? symbols.slice(0, input.maxSymbols) : symbols;
  const allowedSymbolIds = new Set(limitedSymbols.map((symbol) => symbol.id));
  return {
    symbols: limitedSymbols.map(({ exportNames: _exportNames, ...symbol }) => symbol),
    relationships: relationships.filter(
      (edge) => allowedSymbolIds.has(edge.fromSymbolId) && allowedSymbolIds.has(edge.toSymbolId),
    ),
    parseFailedPaths,
    unresolvedImportPaths,
    symbolLimitReached,
    relationshipLimitReached,
  };
}
