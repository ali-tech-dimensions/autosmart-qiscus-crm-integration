'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../middleware/src/phone');

// Every example from Appendix C of the brief.
const appendixC = [
  ['60123456781', '+60123456781'],
  ['+60 12-345 6782', '+60123456782'],
  ['012-345 6783', '+60123456783'],
  ['011-2345 6784', '+601123456784'],
  ['6581234565', '+6581234565'],
  ['+65 9123 4566', '+6591234566'],
  ['6281200000007', '+6281200000007'],
  ['+62 812-0000-0008', '+6281200000008'],
];

for (const [input, expected] of appendixC) {
  test(`normalises ${input} to ${expected}`, () => {
    const r = normalizePhone(input, 'MY');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.e164, expected);
  });
}

test('0812 0000 0009 is ambiguous: local format but not a Malaysian number', () => {
  const r = normalizePhone('0812 0000 0009', 'MY');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.match(r.hint, /\+6281200000009/);
});

test('12345 is invalid', () => {
  const r = normalizePhone('12345', 'MY');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('the default country is configurable', () => {
  const r = normalizePhone('9123 4566', 'SG');
  assert.equal(r.e164, '+6591234566');
  const local = normalizePhone('0812 0000 0009', 'ID');
  assert.equal(local.e164, '+6281200000009');
});

test('platform IDs and empty values are not treated as phones', () => {
  assert.equal(normalizePhone('fb-6281234987650012').reason, 'not_a_phone');
  assert.equal(normalizePhone('').reason, 'missing');
  assert.equal(normalizePhone(null).reason, 'missing');
});

test('00 international prefix and brackets are handled', () => {
  assert.equal(normalizePhone('0060 (12) 345 6781').e164, '+60123456781');
});
