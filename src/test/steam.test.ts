/**
 * Tests for launch-option flag editing.
 *
 * The property that matters: a user's own launch options survive. People put
 * real things in that box — `-windowed -noBorder -benchmarkPass 0`, custom
 * paths — and a button that replaces the whole string to add one flag would
 * quietly delete all of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { hasFlag, withFlag, withoutFlag } from '../main/steam';

test('adding a flag to an empty string yields just the flag', () => {
  assert.equal(withFlag('', '-nobattleye'), '-nobattleye');
});

test('adding a flag keeps the options the user already set', () => {
  assert.equal(
    withFlag('-windowed -noBorder', '-nobattleye'),
    '-windowed -noBorder -nobattleye',
  );
});

test('adding a flag twice does not duplicate it', () => {
  assert.equal(withFlag('-nobattleye', '-nobattleye'), '-nobattleye');
  assert.equal(withFlag('-windowed -nobattleye', '-nobattleye'), '-windowed -nobattleye');
});

test('flags are matched without regard to case', () => {
  // Steam preserves whatever the user typed, and people type -NoBattlEye.
  assert.equal(withFlag('-NoBattlEye', '-nobattleye'), '-NoBattlEye');
  assert.ok(hasFlag('-NOBATTLEYE', '-nobattleye'));
});

test('removing a flag leaves everything else alone', () => {
  assert.equal(withoutFlag('-windowed -nobattleye -noBorder', '-nobattleye'), '-windowed -noBorder');
});

test('removing a flag that is not there changes nothing', () => {
  assert.equal(withoutFlag('-windowed', '-nobattleye'), '-windowed');
});

test('removing the only flag yields an empty string, not whitespace', () => {
  // A string of spaces left in LaunchOptions is not the same as none, and
  // Steam shows it as a set-but-blank value.
  assert.equal(withoutFlag('-nobattleye', '-nobattleye'), '');
  assert.equal(withoutFlag('  -nobattleye  ', '-nobattleye'), '');
});

test('irregular spacing is normalised rather than preserved', () => {
  assert.equal(withFlag('-windowed    -noBorder', '-nobattleye'), '-windowed -noBorder -nobattleye');
});

test('hasFlag does not match a flag that merely starts the same', () => {
  // -nobattleyecheck is not -nobattleye.
  assert.ok(!hasFlag('-nobattleyecheck', '-nobattleye'));
});
