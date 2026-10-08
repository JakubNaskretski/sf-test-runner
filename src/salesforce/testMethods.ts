/**
 * Lightweight scan of Apex source for test entry points, so the test controller
 * can offer a run on the class AND on each `@IsTest` (or `testMethod`) method.
 * This is a regex heuristic, not a parser — good enough to place test items; the
 * CLI is the source of truth for what actually runs.
 */

export interface TestClassInfo {
  /** Class name from the outer class declaration. */
  className: string;
  /** Zero-based line of the class declaration. */
  classLine: number;
  /** The declaration itself carries `@IsTest` (with or without attributes,
   *  on its own line or the same one) — the class-level flag, independent of
   *  whether any method inside is recognised as a test. */
  isTestAnnotated: boolean;
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

// The run of annotations that ends right where the class declaration starts:
// `@IsTest\n`, `@IsTest ` on the same line, `@isTest(SeeAllData=true)\n`, or
// several stacked ones. `[^)]*` spans newlines, so a wrapped attribute list
// still counts.
const TRAILING_ANNOTATIONS_RE = /(?:@\s*\w+(?:\s*\([^)]*\))?\s*)+$/;

/**
 * Whether a source file contains any Apex tests (class-level or method-level
 * `@IsTest`, or the legacy `testMethod` keyword). Cheap gate before scanning.
 */
export function hasApexTests(text: string): boolean {
  return IS_TEST_ANNOTATION_RE.test(text) || TEST_METHOD_KEYWORD_RE.test(text);
}

/**
 * Blank out `//` line comments and `/* … *\/` block comments while preserving the
 * line structure: every stripped character becomes a space and every newline is
 * kept, so an index into the result is still an index into the original source.
 *
 * Apex string literals are single-quoted, and a literal is the one place a `//`
 * or `/*` is not a comment (`'http://example.com'`), so the state machine tracks
 * them. An unterminated literal is bounded to its own line — valid Apex has no
 * multi-line string, and bounding it stops one stray quote from swallowing the
 * rest of the file.
 */
export function stripComments(text: string): string {
  const out: string[] = [];
  let mode: 'code' | 'line' | 'block' | 'string' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    const isNewline = c === '\n' || c === '\r';
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line';
        out.push('  ');
        i++;
      } else if (c === '/' && next === '*') {
        mode = 'block';
        out.push('  ');
        i++;
      } else {
        if (c === "'") mode = 'string';
        out.push(c);
      }
    } else if (mode === 'line') {
      if (isNewline) {
        mode = 'code';
        out.push(c);
      } else {
        out.push(' ');
      }
    } else if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        out.push('  ');
        i++;
      } else {
        out.push(isNewline ? c : ' ');
      }
    } else {
      // Inside a string literal: keep it verbatim, honour `\'` escapes.
      out.push(c);
      if (c === '\\' && next !== undefined && next !== '\n' && next !== '\r') {
        out.push(next);
        i++;
      } else if (c === "'" || isNewline) {
        mode = 'code';
      }
    }
  }
  return out.join('');
}

/**
 * Find the outer class declaration (name + line). Returns null if none.
 *
 * Comments are blanked out first: a file whose header comment says "…this class
 * Foo does…" used to match before the real declaration below it, naming the
 * class after a word in prose. The strip preserves line structure, so the
 * returned `classLine` still indexes the `lines` the caller passed in.
 */
export function findClassDecl(lines: string[]): TestClassInfo | null {
  // Strings blanked too: a `)` inside `@SuppressWarnings('a)b')` would end the
  // annotation's argument list early and hide the `@IsTest` above it.
  const scrubbed = stripCommentsAndStrings(lines.join('\n')).split('\n');
  for (let i = 0; i < scrubbed.length; i++) {
    const m = CLASS_DECL_RE.exec(scrubbed[i]);
    if (m) {
      // Everything before the declaration's first modifier: the annotations
      // that apply to the class are the ones at the very end of it.
      const before = [...scrubbed.slice(0, i), scrubbed[i].slice(0, m.index)].join('\n');
      const block = TRAILING_ANNOTATIONS_RE.exec(before);
      return {
        className: m[1],
        classLine: i,
        isTestAnnotated: block !== null && IS_TEST_ANNOTATION_RE.test(block[0]),
      };
    }
  }
  return null;
}

/**
 * Blank out the CONTENT of single-quoted Apex string literals (quotes kept,
 * every other character a space), so `System.debug('@isTest')` cannot read as
 * an annotation. Run after `stripComments`; line structure and every index
 * are preserved, like there.
 */
function blankStrings(text: string): string {
  return text.replace(/'(?:\\.|[^'\\\r\n])*'/g, (lit) => `'${' '.repeat(lit.length - 2)}'`);
}

/** Apex source with comments and string-literal contents blanked — what is
 *  left is code. Line structure and indices preserved. */
function stripCommentsAndStrings(text: string): string {
  return blankStrings(stripComments(text));
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
  // Comments and string literals blanked, lines kept: a commented-out
  // `// @IsTest` or a `'@isTest'` in a debug line is not an annotation.
  const code = stripCommentsAndStrings(lines.join('\n')).split('\n');
  const methods: TestMethodInfo[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < code.length; i++) {
    const line = code[i];

    // Skip the class declaration line itself.
    if (CLASS_DECL_RE.test(line)) continue;

    const annotatedInline = IS_TEST_ANNOTATION_RE.test(line);
    const testMethodKeyword = TEST_METHOD_KEYWORD_RE.test(line);
    const annotatedAbove = !annotatedInline && hasAnnotationAbove(code, i);

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

// What may follow the annotations on a line that still only OPENS a method
// declaration: modifiers, nothing else — no name, no `(`, no brace.
const MODIFIERS_ONLY_RE =
  /^(?:(?:public|private|protected|global|static|override|final|virtual|abstract|testMethod|webservice)\s*)*$/i;

/**
 * Look back over the preceding lines for an `@isTest` that belongs to THIS
 * declaration. `lines` are already comment-stripped, so comments are blank.
 * A line counts when it is annotations followed by nothing but modifiers —
 * `@IsTest`, `@isTest static` (the signature continues below). A line that
 * carries its own declaration — `@IsTest public class Helper {`,
 * `@IsTest static void a() {}` — owns its annotation, so it ends the look-back
 * instead of lending it to the method below.
 */
function hasAnnotationAbove(lines: string[], index: number): boolean {
  for (let j = index - 1; j >= 0 && j >= index - 4; j--) {
    const prev = lines[j].trim();
    if (prev === '') continue;
    // Anything that is not annotations-then-modifiers (a statement, another
    // declaration, a brace) ends the annotation block.
    if (!prev.startsWith('@') || !MODIFIERS_ONLY_RE.test(prev.replace(LEADING_ANNOTATIONS_RE, '').trim())) {
      return false;
    }
    if (IS_TEST_ANNOTATION_RE.test(prev)) return true;
  }
  return false;
}

function isNoise(name: string): boolean {
  return /^(if|for|while|switch|catch|return|new|else|do|try)$/i.test(name);
}

/**
 * Class names a test class DECLARES it tests, from Salesforce's `testFor`
 * annotation property (API v66+): `@IsTest(testFor='ApexClass:Foo')`, on the
 * class or on a method, one or more comma-separated `Kind:Name` tokens where
 * Kind is `ApexClass` or `ApexTrigger` and Name may carry a `.method` suffix.
 *
 * Read from the source text on purpose: the Tooling API's SymbolTable reports
 * the annotation as a bare `IsTest` with no properties, so the body is the only
 * place the declaration survives.
 */
export function findTestForTargets(lines: string[]): string[] {
  const text = stripComments(lines.join('\n'));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const annotation of text.matchAll(/@\s*isTest\s*\(([^)]*)\)/gi)) {
    for (const property of annotation[1].matchAll(/testFor\s*=\s*'([^']*)'/gi)) {
      for (const token of property[1].split(/[,\s]+/)) {
        // `ApexClass:Foo` and `ApexTrigger:Bar.method` both name their target in
        // the middle segment; a bare name is taken as written.
        const name = (token.includes(':') ? token.slice(token.indexOf(':') + 1) : token)
          .split('.')[0]
          .trim();
        if (!/^\w+$/.test(name)) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out;
}
