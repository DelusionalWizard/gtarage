/**
 * Tests for update version comparison.
 *
 * The failure modes here are both silent and both bad: comparing versions as
 * strings makes `0.4.10` look older than `0.4.9`, so a real update is never
 * offered; and treating a prerelease as newer than the release it precedes
 * makes the app offer to "update" a user backwards onto a beta.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isNewer } from '../main/updater';

test('a higher patch is newer', () => {
  assert.ok(isNewer('0.4.2', '0.4.1'));
  assert.ok(!isNewer('0.4.1', '0.4.2'));
});

test('double-digit versions compare numerically, not as strings', () => {
  // The classic bug: '0.4.10' < '0.4.9' as a string, so the update is missed.
  assert.ok(isNewer('0.4.10', '0.4.9'));
  assert.ok(!isNewer('0.4.9', '0.4.10'));
  assert.ok(isNewer('0.10.0', '0.9.9'));
  assert.ok(isNewer('1.0.0', '0.99.99'));
});

test('an identical version is not an update', () => {
  assert.ok(!isNewer('0.4.2', '0.4.2'));
  assert.ok(!isNewer('0.4.2-beta.1', '0.4.2-beta.1'));
});

test('a leading v is ignored', () => {
  assert.ok(isNewer('v0.5.0', '0.4.2'));
  assert.ok(!isNewer('v0.4.2', 'v0.4.2'));
});

test('a release beats the prerelease that preceded it', () => {
  assert.ok(isNewer('0.4.2', '0.4.2-beta.1'));
  assert.ok(!isNewer('0.4.2-beta.1', '0.4.2'));
});

test('prereleases of the same version order sensibly', () => {
  assert.ok(isNewer('0.4.2-beta.2', '0.4.2-beta.1'));
  assert.ok(!isNewer('0.4.2-beta.1', '0.4.2-beta.2'));
  // Numeric-aware, so beta.10 is not "less than" beta.9.
  assert.ok(isNewer('0.4.2-beta.10', '0.4.2-beta.9'));
});

test('a newer version wins regardless of prerelease suffix', () => {
  assert.ok(isNewer('0.5.0-beta.1', '0.4.2'));
  assert.ok(!isNewer('0.4.2', '0.5.0-beta.1'));
});

test('missing components are treated as zero', () => {
  assert.ok(isNewer('0.5', '0.4.9'));
  assert.ok(!isNewer('0.4', '0.4.0'));
});
