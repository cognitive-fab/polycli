'use strict';
// Unit tests for app/src/main/tests.js
const { parseSummary, failedNames, groupOf } = require('../tests');

// ============================================================================
// groupOf() tests
// ============================================================================

console.log('Testing groupOf()...');

// Test test* scripts
const testScripts = ['test', 'test:unit', 'test-all', 'test:integration'];
for (const script of testScripts) {
  const result = groupOf(script);
  console.assert(result === 'tests', `groupOf("${script}") should return 'tests', got: ${result}`);
}

// Test check* scripts
const checkScripts = ['check', 'check:lint', 'verify', 'verify:all', 'selftest', 'typecheck', 'lint', 'smoke', 'smoke:test'];
for (const script of checkScripts) {
  const result = groupOf(script);
  console.assert(result === 'checks', `groupOf("${script}") should return 'checks', got: ${result}`);
}

// Test ci script
console.assert(groupOf('ci') === 'ci', `groupOf("ci") should return 'ci'`);

// Test non-matching scripts
const nonMatching = ['build', 'start', 'dev', 'prettier', ''];
for (const script of nonMatching) {
  const result = groupOf(script);
  console.assert(result === null, `groupOf("${script}") should return null, got: ${result}`);
}

console.log('groupOf() tests passed!\n');

// ============================================================================
// parseSummary() tests
// ============================================================================

console.log('Testing parseSummary()...');

// Test node:test / TAP format with # prefix
const nodeTestOutput = `
# tests 10
# pass 8
# fail 2
# skipped 1
# duration_ms 123.456
`;
const nodeTestResult = parseSummary(nodeTestOutput);
console.assert(nodeTestResult.tests === 10, `tests should be 10, got: ${nodeTestResult.tests}`);
console.assert(nodeTestResult.pass === 8, `pass should be 8, got: ${nodeTestResult.pass}`);
console.assert(nodeTestResult.fail === 2, `fail should be 2, got: ${nodeTestResult.fail}`);
console.assert(nodeTestResult.skip === 1, `skip should be 1, got: ${nodeTestResult.skip}`);
console.assert(nodeTestResult.ms === 123, `ms should be 123, got: ${nodeTestResult.ms}`);

// Test node:test format with ℹ prefix
const nodeTestOutput2 = `
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ duration_ms 50
`;
const nodeTestResult2 = parseSummary(nodeTestOutput2);
console.assert(nodeTestResult2.tests === 5, `tests should be 5, got: ${nodeTestResult2.tests}`);
console.assert(nodeTestResult2.pass === 5, `pass should be 5, got: ${nodeTestResult2.pass}`);
console.assert(nodeTestResult2.fail === 0, `fail should be 0, got: ${nodeTestResult2.fail}`);
console.assert(nodeTestResult2.ms === 50, `ms should be 50, got: ${nodeTestResult2.ms}`);

// Test Jest format - note: the regex expects order: failed, skipped, passed, total
// Jest output must have "total" at the end and match the expected order
const jestOutput = `
Tests:        2 failed, 0 skipped, 18 passed, 20 total
`;
const jestResult = parseSummary(jestOutput);
console.assert(jestResult.tests === 20, `tests should be 20, got: ${jestResult.tests}`);
console.assert(jestResult.fail === 2, `fail should be 2, got: ${jestResult.fail}`);
console.assert(jestResult.pass === 18, `pass should be 18, got: ${jestResult.pass}`);
console.assert(jestResult.skip === 0, `skip should be 0, got: ${jestResult.skip}`);

// Test Jest format with skipped
const jestOutput2 = `
Tests:        3 failed, 2 skipped, 15 passed, 20 total
`;
const jestResult2 = parseSummary(jestOutput2);
console.assert(jestResult2.tests === 20, `tests should be 20, got: ${jestResult2.tests}`);
console.assert(jestResult2.fail === 3, `fail should be 3, got: ${jestResult2.fail}`);
console.assert(jestResult2.skip === 2, `skip should be 2, got: ${jestResult2.skip}`);
console.assert(jestResult2.pass === 15, `pass should be 15, got: ${jestResult2.pass}`);

// Test Jest format with only total
const jestOutput3 = `
Tests:        20 total
`;
const jestResult3 = parseSummary(jestOutput3);
console.assert(jestResult3.tests === 20, `tests should be 20, got: ${jestResult3.tests}`);
console.assert(jestResult3.fail === 0, `fail should be 0, got: ${jestResult3.fail}`);
console.assert(jestResult3.pass === 0, `pass should be 0, got: ${jestResult3.pass}`);
console.assert(jestResult3.skip === 0, `skip should be 0, got: ${jestResult3.skip}`);

// Test empty output
const emptyResult = parseSummary('');
console.assert(emptyResult.tests === null, `tests should be null, got: ${emptyResult.tests}`);
console.assert(emptyResult.pass === null, `pass should be null, got: ${emptyResult.pass}`);
console.assert(emptyResult.fail === null, `fail should be null, got: ${emptyResult.fail}`);
console.assert(emptyResult.skip === null, `skip should be null, got: ${emptyResult.skip}`);
console.assert(emptyResult.ms === null, `ms should be null, got: ${emptyResult.ms}`);

// Test chained scripts (multiple summaries)
const chainedOutput = `
# tests 5
# pass 5
# tests 3
# pass 2
# fail 1
`;
const chainedResult = parseSummary(chainedOutput);
console.assert(chainedResult.tests === 8, `tests should be 8 (5+3), got: ${chainedResult.tests}`);
console.assert(chainedResult.pass === 7, `pass should be 7 (5+2), got: ${chainedResult.pass}`);
console.assert(chainedResult.fail === 1, `fail should be 1, got: ${chainedResult.fail}`);

// Test duration_ms rounding
const durationOutput = `
# duration_ms 123.999
`;
const durationResult = parseSummary(durationOutput);
console.assert(durationResult.ms === 124, `ms should be 124 (rounded), got: ${durationResult.ms}`);

console.log('parseSummary() tests passed!\n');

// ============================================================================
// failedNames() tests
// ============================================================================

console.log('Testing failedNames()...');

// Test ✖ prefix
const failOutput1 = `
✖ my test failed
✖ another test failed (123.45ms)
✓ this test passed
`;
const failNames1 = failedNames(failOutput1);
console.assert(failNames1.length === 2, `should find 2 failed names, got: ${failNames1.length}`);
console.assert(failNames1.includes('my test failed'), `should include 'my test failed'`);
console.assert(failNames1.includes('another test failed'), `should include 'another test failed'`);

// Test ✗ prefix
const failOutput2 = `
✗ test one failed
✗ test two failed
`;
const failNames2 = failedNames(failOutput2);
console.assert(failNames2.length === 2, `should find 2 failed names, got: ${failNames2.length}`);

// Test × prefix
const failOutput3 = `
× test with x mark
`;
const failNames3 = failedNames(failOutput3);
console.assert(failNames3.length === 1, `should find 1 failed name, got: ${failNames3.length}`);
console.assert(failNames3[0] === 'test with x mark', `should include 'test with x mark'`);

// Test TAP format (not ok)
const tapOutput = `
not ok 1 - my tap test failed
not ok 2 - another tap test # comment
ok 3 - passing test
`;
const tapNames = failedNames(tapOutput);
console.assert(tapNames.length === 2, `should find 2 failed names, got: ${tapNames.length}`);
console.assert(tapNames.includes('my tap test failed'), `should include 'my tap test failed'`);
console.assert(tapNames.includes('another tap test'), `should include 'another tap test'`);

// Test filtering of summary lines
const summaryOutput = `
✖ failing tests
✖ tests 5
✖ my actual failure
`;
const summaryNames = failedNames(summaryOutput);
console.assert(summaryNames.length === 1, `should filter out summary lines, got: ${summaryNames.length}`);
console.assert(summaryNames[0] === 'my actual failure', `should only include 'my actual failure'`);

// Test max 25 limit
// Note: avoid test names starting with "test <number>" as they match the filter regex
const manyFails = Array.from({ length: 30 }, (_, i) => `✖ myTest${i} failed`).join('\n');
const manyNames = failedNames(manyFails);
console.assert(manyNames.length === 25, `should limit to 25 names, got: ${manyNames.length}`);

// Test long name truncation
const longName = 'a'.repeat(200);
const longOutput = `✖ ${longName}`;
const longNames = failedNames(longOutput);
console.assert(longNames[0].length === 160, `should truncate to 160 chars, got: ${longNames[0].length}`);

// Test empty output
const emptyNames = failedNames('');
console.assert(emptyNames.length === 0, `should return empty array, got: ${emptyNames.length}`);

// Test whitespace handling
const whitespaceOutput = `
  ✖   test with spaces   
`;
const whitespaceNames = failedNames(whitespaceOutput);
console.assert(whitespaceNames.length === 1, `should handle whitespace, got: ${whitespaceNames.length}`);
console.assert(whitespaceNames[0] === 'test with spaces', `should trim whitespace, got: '${whitespaceNames[0]}'`);

// Test deduplication
const dupOutput = `
✖ same test
✖ same test
`;
const dupNames = failedNames(dupOutput);
console.assert(dupNames.length === 1, `should deduplicate, got: ${dupNames.length}`);

console.log('failedNames() tests passed!\n');

// ============================================================================
// Summary
// ============================================================================

console.log('All tests passed! ✓');
