/**
 * Tests for the KeyValues subset used to edit Steam launch options.
 *
 * The shapes here are taken from a real `localconfig.vdf`: tab indentation,
 * repeated key names at different depths, and an `apps` block whose children
 * are numeric app ids. The repetition is the whole risk — a regex edit finds
 * the first `LaunchOptions` in the file, which belongs to whichever game
 * Steam happened to write first.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVdf, stringifyVdf, vdfEnsure, vdfGet } from '../shared/vdf';

const SAMPLE = `"UserLocalConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"apps"
\t\t\t\t{
\t\t\t\t\t"271590"
\t\t\t\t\t{
\t\t\t\t\t\t"LaunchOptions"\t\t"-windowed"
\t\t\t\t\t\t"LastPlayed"\t\t"1700000000"
\t\t\t\t\t}
\t\t\t\t\t"3240220"
\t\t\t\t\t{
\t\t\t\t\t\t"LastPlayed"\t\t"1700000001"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('a nested app block is reachable by path', () => {
  const root = parseVdf(SAMPLE);
  const value = vdfGet(root, [
    'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', '271590', 'LaunchOptions',
  ]);
  assert.equal(value, '-windowed');
});

test('key lookup is case-insensitive', () => {
  // Steam has shipped both `apps` and `Apps`, and both `Software` and
  // `software`. An exact match silently misses the block that is right there.
  const root = parseVdf(SAMPLE);
  const value = vdfGet(root, [
    'userlocalconfigstore', 'SOFTWARE', 'valve', 'steam', 'APPS', '271590', 'launchoptions',
  ]);
  assert.equal(value, '-windowed');
});

test('a missing path yields undefined rather than throwing', () => {
  const root = parseVdf(SAMPLE);
  assert.equal(vdfGet(root, ['UserLocalConfigStore', 'nope', 'deeper']), undefined);
});

test('a round trip preserves every app block', () => {
  const root = parseVdf(SAMPLE);
  const again = parseVdf(stringifyVdf(root));
  const apps = vdfGet(again, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps']);
  assert.ok(apps && typeof apps === 'object');
  assert.deepEqual(Object.keys(apps as object).sort(), ['271590', '3240220']);
});

test('editing one app does not touch another', () => {
  // The regression this file exists for.
  const root = parseVdf(SAMPLE);
  const app = vdfEnsure(root, [
    'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', '3240220',
  ]);
  app.LaunchOptions = '-nobattleye';

  const out = parseVdf(stringifyVdf(root));
  const path = ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'];
  assert.equal(vdfGet(out, [...path, '3240220', 'LaunchOptions']), '-nobattleye');
  assert.equal(
    vdfGet(out, [...path, '271590', 'LaunchOptions']),
    '-windowed',
    'the other game keeps its own launch options',
  );
  assert.equal(
    vdfGet(out, [...path, '3240220', 'LastPlayed']),
    '1700000001',
    'sibling keys inside the edited block survive',
  );
});

test('an app with no block at all gets one created', () => {
  const root = parseVdf(SAMPLE);
  const app = vdfEnsure(root, [
    'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', '12210',
  ]);
  app.LaunchOptions = '-nobattleye';
  const out = parseVdf(stringifyVdf(root));
  assert.equal(
    vdfGet(out, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', '12210', 'LaunchOptions']),
    '-nobattleye',
  );
});

test('quotes and backslashes survive a round trip', () => {
  // Launch options legitimately contain paths, and a mishandled backslash
  // rewrites someone's -customPath argument.
  const root = parseVdf('"root"\n{\n\t"a"\t\t"C:\\\\Games\\\\GTA V"\n}\n');
  assert.equal(vdfGet(root, ['root', 'a']), 'C:\\Games\\GTA V');
  assert.equal(vdfGet(parseVdf(stringifyVdf(root)), ['root', 'a']), 'C:\\Games\\GTA V');
});

test('comments outside strings are ignored', () => {
  const root = parseVdf('// a comment\n"root"\n{\n\t"a"\t\t"1" // trailing\n}\n');
  assert.equal(vdfGet(root, ['root', 'a']), '1');
});
