import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasApexTests,
  findClassDecl,
  findTestForTargets,
  findTestMethods,
  stripComments,
} from './testMethods';

const CLASS = `@isTest
public class MyTestClass {
    @isTest
    static void testAlpha() {
        System.assert(true);
    }

    @IsTest
    static void testBeta() {
        System.assert(true);
    }

    // a helper, not a test
    static void makeData() {
        Integer x = 1;
    }
}`;

test('hasApexTests detects @isTest annotation', () => {
  assert.equal(hasApexTests(CLASS), true);
  assert.equal(hasApexTests('public class Plain { void x() {} }'), false);
});

test('hasApexTests detects legacy testMethod keyword', () => {
  assert.equal(hasApexTests('class C { static testMethod void t() {} }'), true);
});

test('findClassDecl returns the class name and line', () => {
  const lines = CLASS.split('\n');
  const decl = findClassDecl(lines);
  assert.equal(decl!.className, 'MyTestClass');
  assert.equal(decl!.classLine, 1);
});

test('findTestMethods finds annotated methods, skips helpers', () => {
  const lines = CLASS.split('\n');
  const methods = findTestMethods(lines, 'MyTestClass');
  const names = methods.map((m) => m.methodName);
  assert.deepEqual(names, ['testAlpha', 'testBeta']);
});

test('findTestMethods handles inline annotation on the signature line', () => {
  const src = `public class C {
    @isTest static void inlineTest() {}
}`;
  const methods = findTestMethods(src.split('\n'), 'C');
  assert.deepEqual(methods.map((m) => m.methodName), ['inlineTest']);
});

test('findTestMethods handles legacy testMethod keyword', () => {
  const src = `public class C {
    static testMethod void legacyOne() {}
    static void notATest() {}
}`;
  const methods = findTestMethods(src.split('\n'), 'C');
  assert.deepEqual(methods.map((m) => m.methodName), ['legacyOne']);
});

test('a parenthesized @IsTest(SeeAllData=…) line is not a method named "IsTest"', () => {
  const src = `@IsTest
private class ProbeTest {
    @IsTest(SeeAllData=false)
    static void testFail() {
        System.assert(false);
    }
}`;
  const methods = findTestMethods(src.split('\n'), 'ProbeTest');
  assert.deepEqual(methods.map((m) => m.methodName), ['testFail']);
});

test('inline parenthesized annotation still yields the real method name', () => {
  const src = `public class C {
    @isTest(SeeAllData=true) static void seesAllData() {}
}`;
  const methods = findTestMethods(src.split('\n'), 'C');
  assert.deepEqual(methods.map((m) => m.methodName), ['seesAllData']);
});

test('findTestMethods does not treat the class declaration as a method', () => {
  const methods = findTestMethods(CLASS.split('\n'), 'MyTestClass');
  assert.ok(!methods.some((m) => m.methodName === 'MyTestClass'));
});

test('findTestMethods returns method line numbers', () => {
  const lines = CLASS.split('\n');
  const methods = findTestMethods(lines, 'MyTestClass');
  // testAlpha is declared on line index 3 (0-based).
  const alpha = methods.find((m) => m.methodName === 'testAlpha');
  assert.equal(alpha!.line, 3);
});

test('a "class X" mention in a header comment does not win over the declaration', () => {
  const src = `/**
 * Helper for the Acme billing flow. Pairs with class AcmeBillingHelper and is
 * exercised by class AcmeGhost, which does not exist.
 */
@IsTest
private class AcmeBillingServiceTest {
    // class AcmeCommentOnly
    @IsTest
    static void testInvoiceTotals() {
        System.assertEquals(1, 1);
    }
}`;
  const lines = src.split('\n');
  const decl = findClassDecl(lines);
  assert.equal(decl!.className, 'AcmeBillingServiceTest');
  // Line 5 (0-based) is the real declaration; the comment mentions sit above it.
  assert.equal(decl!.classLine, 5);
  assert.equal(lines[decl!.classLine].includes('class AcmeBillingServiceTest'), true);
});

test('a commented-out class declaration is ignored', () => {
  const src = `// public class OldAcmeTest {
@IsTest
private class AcmeOrderTest {
    @IsTest
    static void testOrder() {}
}`;
  const decl = findClassDecl(src.split('\n'));
  assert.equal(decl!.className, 'AcmeOrderTest');
});

test('stripComments keeps line structure and leaves string literals alone', () => {
  const src = `String endpoint = 'https://acme.example.com//path';
// class Ghost
Integer x = 1; /* class Ghost2 */ Integer y = 2;`;
  const stripped = stripComments(src);
  assert.equal(stripped.split('\n').length, src.split('\n').length);
  assert.equal(stripped.split('\n')[0], src.split('\n')[0]);
  assert.equal(/class\s+Ghost/.test(stripped), false);
  assert.match(stripped.split('\n')[2], /Integer x = 1;\s+Integer y = 2;/);
});

test('stripComments preserves method line numbers for findTestMethods', () => {
  const src = `/* Acme
   multi-line
   header */
@IsTest
private class AcmeRefundTest {
    @IsTest
    static void testRefund() {}
}`;
  const lines = stripComments(src).split('\n');
  const methods = findTestMethods(lines, 'AcmeRefundTest');
  assert.deepEqual(methods.map((m) => [m.methodName, m.line]), [['testRefund', 6]]);
});

test('findTestForTargets reads class and method level testFor declarations', () => {
  const src = [
    "@IsTest(testFor='ApexClass:OrderService, ApexTrigger:OrderTrigger')",
    'private class OrderServiceTest {',
    "  @IsTest(testFor='ApexClass:OrderSelector.selectAll')",
    '  static void testSelect() {}',
    '}',
  ];
  assert.deepEqual(findTestForTargets(src), [
    'OrderService',
    'OrderTrigger',
    'OrderSelector',
  ]);
});

test('findTestForTargets ignores a commented-out declaration and plain @IsTest', () => {
  const src = [
    "// @IsTest(testFor='ApexClass:Ghost')",
    '@IsTest(SeeAllData=true)',
    'private class OrderServiceTest {}',
  ];
  assert.deepEqual(findTestForTargets(src), []);
});

// ─────────────────── method shapes and the class-level flag ───────────────────

/** Method names found in `body`, wrapped in an @IsTest class. */
function methodsIn(body: string): string[] {
  const src = `@IsTest\nprivate class AcmeShapesTest {\n${body}\n}`;
  return findTestMethods(src.split('\n'), 'AcmeShapesTest').map((m) => m.methodName);
}

test('method shapes: annotation inline, with attributes, on the line above, legacy keyword', () => {
  assert.deepEqual(methodsIn('  @IsTest static void t() {\n  }'), ['t']);
  assert.deepEqual(methodsIn('  @IsTest(SeeAllData=true) static void t() {}'), ['t']);
  assert.deepEqual(methodsIn('  @isTest\n  static void t() {}'), ['t']);
  assert.deepEqual(methodsIn('  static testMethod void t() {}'), ['t']);
});

test('method shapes: "@isTest static" on one line, the signature on the next', () => {
  assert.deepEqual(methodsIn('  @isTest static\n  void testA() {}'), ['testA']);
  assert.deepEqual(methodsIn('  @IsTest(SeeAllData=true) public static\n  void testB() {}'), ['testB']);
  assert.deepEqual(methodsIn('  @isTest\n  static\n  void notSeen() {}'), []);
});

test('method shapes: unannotated methods inside an @IsTest class are not tests', () => {
  assert.deepEqual(
    methodsIn('  static void helper() {}\n  public static Account make() { return null; }'),
    [],
  );
});

test('a one-line "@IsTest public class X {" does not make the next method a test', () => {
  const src = '@IsTest public class AcmeHelper {\n    public static void make() {}\n}';
  assert.deepEqual(findTestMethods(src.split('\n'), 'AcmeHelper'), []);
});

test('a one-line annotated test method does not lend its annotation to the next method', () => {
  assert.deepEqual(methodsIn('  @IsTest static void a() { }\n  static void b() {}'), ['a']);
});

test('a commented-out @IsTest or one inside a string literal is not an annotation', () => {
  assert.deepEqual(methodsIn('  // @isTest\n  static void old() {}'), []);
  assert.deepEqual(methodsIn('  /* @IsTest */\n  static void old() {}'), []);
  assert.deepEqual(
    methodsIn("  static void x() { System.debug('@isTest'); }\n  static void y() {\n    System.debug('@isTest marker');\n  }"),
    [],
  );
});

test('stacked annotations above a method still find the @IsTest among them', () => {
  assert.deepEqual(methodsIn("  @IsTest\n  @SuppressWarnings('PMD')\n  static void t() {}"), ['t']);
});

test('findClassDecl reads the class-level @IsTest flag in every shape', () => {
  const flag = (src: string): boolean | undefined => findClassDecl(src.split('\n'))?.isTestAnnotated;
  assert.equal(flag('@isTest\npublic class AcmeHelper {\n}'), true);
  assert.equal(flag('@IsTest public class AcmeHelper {\n}'), true);
  assert.equal(flag('@isTest(SeeAllData=true)\nprivate class AcmeHelper {\n}'), true);
  assert.equal(flag("@IsTest(testFor='ApexClass:AcmeOrder')\nprivate class AcmeOrderTest {\n}"), true);
  assert.equal(flag("@SuppressWarnings('PMD')\n@IsTest\nprivate class AcmeHelper {\n}"), true);
  assert.equal(flag('/** header */\n@IsTest\n\nprivate class AcmeHelper {\n}'), true);
  // A `)` inside a string argument does not end the annotation early.
  assert.equal(flag("@IsTest\n@SuppressWarnings('a)b')\nprivate class AcmeHelper {\n}"), true);
  // Not on the class: a plain class, a commented-out flag, a method-level one.
  assert.equal(flag('public class AcmeService {\n}'), false);
  assert.equal(flag('// @IsTest\npublic class AcmeService {\n}'), false);
  assert.equal(flag('public class AcmeService {\n  @IsTest static void t() {}\n}'), false);
  assert.equal(flag("@SuppressWarnings('PMD')\npublic class AcmeService {\n}"), false);
});
