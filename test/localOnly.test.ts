import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, isLocalOrigin } from '../server/localOnly.ts';

test('lokale Host-Namen sind erlaubt', () => {
  for (const h of ['localhost', 'localhost:8080', '127.0.0.1:3001', '[::1]:8080', 'gpt-chess.localhost', 'GPT-Chess.localhost:8080']) assert.ok(isLocalHost(h), h);
});

test('fremde Host-Namen (DNS-Rebinding) werden abgewiesen', () => {
  for (const h of [undefined, '', 'evil.example.com', 'evil.example.com:8080', 'localhost.evil.com', '127.0.0.1.nip.io', '192.168.1.10:8080']) assert.ok(!isLocalHost(h), String(h));
});

test('zusätzlicher Host aus APP_URL ist erlaubt', () => {
  assert.ok(isLocalHost('chess.lan:8080', ['chess.lan']));
});

test('Origin: fehlend oder lokal erlaubt, fremd oder "null" abgewiesen', () => {
  assert.ok(isLocalOrigin(undefined));
  assert.ok(isLocalOrigin('http://localhost:5173'));
  assert.ok(isLocalOrigin('http://gpt-chess.localhost:8080'));
  assert.ok(!isLocalOrigin('https://evil.example.com'));
  assert.ok(!isLocalOrigin('null'));
  assert.ok(!isLocalOrigin('file://'));
});
