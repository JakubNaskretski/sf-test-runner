import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasApexTests, findClassDecl, findTestMethods } from './testMethods';

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
