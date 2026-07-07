/**
 * Lightweight scan of Apex source for test entry points, so the CodeLens
 * provider can offer "Run" on the class AND on each `@IsTest` (or `testMethod`)
 * method. This is a regex heuristic, not a parser — good enough
 * to place lenses; the CLI is the source of truth for what actually runs.
 */

export interface TestClassInfo {
  /** Class name from the outer class declaration. */
  className: string;
  /** Zero-based line of the class declaration. */
  classLine: number;
}

export interface TestMethodInfo {
  /** Method name. */
  methodName: string;
  /** Zero-based line of the method declaration. */
  line: number;
}

const CLASS_DECL_RE =
  /\b(?:public|private|global)\s+(?:with\s+sharing\s+|without\s+sharing\s+|inherited\s+sharing\s+)?(?:virtual\s+|abstract\s+)?class\s+(\w+)/i;

const IS_TEST_ANNOTATION_RE = /@\s*isTest\b/i;

// A method signature line: optional modifiers, a return type, the name, and `(`.
// We capture the name (the identifier immediately before the paren list).
const METHOD_SIG_RE =
  /\b(?:public|private|global|protected)?\s*(?:static\s+)?(?:testMethod\s+)?[\w<>[\],.\s]*?\b(\w+)\s*\(/i;

// `testMethod` keyword form (legacy) marks a test method without an annotation.
const TEST_METHOD_KEYWORD_RE = /\btestMethod\b/i;

// One or more annotations at the start of a line, with optional `(args)` —
// stripped before signature matching so `@IsTest(SeeAllData=true)` can't be
// mistaken for a method named "IsTest" (its paren list matches METHOD_SIG_RE).
const LEADING_ANNOTATIONS_RE = /^\s*(?:@\s*\w+\s*(?:\([^)]*\))?\s*)+/;

/**
 * Whether a source file contains any Apex tests (class-level or method-level
 * `@IsTest`, or the legacy `testMethod` keyword). Cheap gate before scanning.
 */
export function hasApexTests(text: string): boolean {
  return IS_TEST_ANNOTATION_RE.test(text) || TEST_METHOD_KEYWORD_RE.test(text);
}

/** Find the outer class declaration (name + line). Returns null if none. */
export function findClassDecl(lines: string[]): TestClassInfo | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CLASS_DECL_RE);
    if (m) return { className: m[1], classLine: i };
  }
  return null;
}

/**
 * Find every test method in the source: a method whose declaration is either
 * preceded by an `@IsTest` annotation (possibly on the line above, allowing
 * blank/comment lines between) or carries the `testMethod` keyword. Returns them
 * in source order with their zero-based lines.
 *
 * Heuristic and deliberately conservative: it looks back a few non-blank lines
 * for an `@isTest` annotation and treats an annotation on the same line as the
 * signature as valid too. Constructors and the class declaration are skipped.
 */
export function findTestMethods(lines: string[], className?: string): TestMethodInfo[] {
  const methods: TestMethodInfo[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip the class declaration line itself.
    if (CLASS_DECL_RE.test(line)) continue;

    const annotatedInline = IS_TEST_ANNOTATION_RE.test(line);
    const testMethodKeyword = TEST_METHOD_KEYWORD_RE.test(line);
    const annotatedAbove = !annotatedInline && hasAnnotationAbove(lines, i);

    if (!annotatedInline && !annotatedAbove && !testMethodKeyword) continue;

    const sig = line.replace(LEADING_ANNOTATIONS_RE, '').match(METHOD_SIG_RE);
    if (!sig) continue;
    const name = sig[1];
    // Ignore control-flow keywords, the constructor (name === className), and
    // the annotation-only line (which has no `(` for a real signature anyway).
    if (isNoise(name) || (className && name === className)) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    methods.push({ methodName: name, line: i });
  }
  return methods;
}

/** Look back over the preceding non-blank/comment lines for an `@isTest`. */
function hasAnnotationAbove(lines: string[], index: number): boolean {
  for (let j = index - 1; j >= 0 && j >= index - 4; j--) {
    const prev = lines[j].trim();
    if (prev === '') continue;
    if (IS_TEST_ANNOTATION_RE.test(prev)) return true;
    // Stop at anything that clearly isn't an annotation/comment (a real
    // statement or another declaration ends the annotation block).
    if (!prev.startsWith('@') && !prev.startsWith('//') && !prev.startsWith('*') && !prev.startsWith('/*')) {
      return false;
    }
  }
  return false;
}

function isNoise(name: string): boolean {
  return /^(if|for|while|switch|catch|return|new|else|do|try)$/i.test(name);
}
