// Workstream Claude configuration (docs/design/v0.4.md §1, §2): permission profiles,
// the settings written for a session, the project-rule cleanup, skill front matter, and
// the complete-lines reader the transcript and ledger readers share.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_PROFILES, cleanPermissions, cleanProfile, mcpPrefix, sessionPermissions } = require('../profiles');
const { readNewLines } = require('../jsonl');
const cc = require('../claudeconfig');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'polycli-test-'));

test('a workstream on Standard with nothing of its own adds no permissions', () => {
  assert.equal(sessionPermissions({}, DEFAULT_PROFILES), null);
  assert.equal(sessionPermissions({ profile: 'standard', perm: cleanPermissions({}) }, DEFAULT_PROFILES), null);
});

test('profile rules, own rules and MCP servers that are off are merged without repeats', () => {
  const w = { profile: 'careful', perm: cleanPermissions({ deny: ['Bash(rm *)', 'WebFetch(domain:evil.example)'], mode: 'auto' }), mcpOff: ['claude.ai Google Drive', 'plugin:github:github'] };
  const p = sessionPermissions(w, DEFAULT_PROFILES);
  assert.ok(p.ask.includes('Bash(git push *)'));
  assert.equal(p.deny.filter(r => r === 'Bash(rm *)').length, 1);
  assert.ok(p.deny.includes('mcp__claude_ai_Google_Drive'));
  assert.ok(p.deny.includes('mcp__plugin_github_github'));
  assert.equal(p.defaultMode, 'auto');
});

test('an unknown profile falls back to nothing added', () => {
  assert.equal(sessionPermissions({ profile: 'gone' }, DEFAULT_PROFILES), null);
});

test('MCP server names map to their tool prefix', () => {
  assert.equal(mcpPrefix('agentmesh'), 'mcp__agentmesh');
  assert.equal(mcpPrefix('plugin:small-business:shopify'), 'mcp__plugin_small-business_shopify');
});

test('rules are checked: Tool or Tool(pattern), no bypass, no strange modes', () => {
  assert.deepEqual(cleanPermissions({ allow: [' Bash(npm test) ', 'Bash(npm test)', ''] }).allow, ['Bash(npm test)']);
  assert.throws(() => cleanPermissions({ deny: ['rm -rf /'] }), /not a permission rule/);
  assert.throws(() => cleanPermissions({ mode: 'bypassPermissions' }), /Unknown permission mode/);
  assert.throws(() => cleanPermissions({ dirs: ['relative/folder'] }), /absolute/);
  assert.equal(cleanProfile({ name: 'My Rules!' }).id, 'my-rules');
});

test('every starting profile is valid as it stands', () => {
  for (const p of DEFAULT_PROFILES) assert.deepEqual(cleanProfile(p).deny, p.deny);
});

test('readNewLines leaves a half-written last line for the next read', async () => {
  const f = path.join(tmp(), 'log.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
  let r = await readNewLines(f, 0);
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  fs.appendFileSync(f, '3}\n');
  r = await readNewLines(f, r.offset);
  assert.deepEqual(r.lines, ['{"c":3}']);
  fs.writeFileSync(f, '{"z":0}\n');                 // rewritten shorter: read again from the start
  r = await readNewLines(f, r.offset);
  assert.equal(r.restarted, true);
  assert.deepEqual(r.lines, ['{"z":0}']);
  assert.equal((await readNewLines(path.join(tmp(), 'none.jsonl'))).missing, true);
});

test('project rules: credentials and whole-tool rules are flagged and masked; Remove edits only the local file', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude'));
  const local = { model: 'x', permissions: { allow: ['Bash(npm test)', 'Bash(AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123 aws s3 ls)', 'PowerShell'], deny: [] } };
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(local));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Write'] } }));
  const { rules } = cc.projectRules(dir);
  const aws = rules.find(r => /AKIA/.test(r.display));
  assert.ok(aws.flags.some(f => /AWS access key/.test(f)) && aws.flags.some(f => /AWS secret key/.test(f)));
  assert.ok(!/ABCDEFGHIJKLMNOP|abcdefghijklmnopqrstuvwxyz/.test(aws.display), 'the key is masked');
  assert.ok(rules.find(r => r.display === 'PowerShell').flags.includes('allows a whole tool'));
  assert.equal(rules.find(r => r.display === 'Write').key, null, 'shared settings.json rules are not removable');
  cc.removeProjectRule(dir, aws.key);
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(after.permissions.allow, ['Bash(npm test)', 'PowerShell']);
  assert.equal(after.model, 'x', 'other settings are kept');
  assert.throws(() => cc.removeProjectRule(dir, aws.key), /no longer/);
});

test('skill front matter: name, description, folded description, missing front matter', () => {
  const dir = tmp();
  const mk = (name, text) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text); return path.join(dir, name); };
  assert.deepEqual(cc.skillInfo(mk('a', '---\nname: alpha\ndescription: "Does A"\n---\nbody')).name, 'alpha');
  assert.equal(cc.skillInfo(mk('b', '---\nname: beta\ndescription: >\n  first line\n  second line\nother: x\n---\n')).description, 'first line second line');
  assert.equal(cc.skillInfo(mk('c', 'no front matter')).name, 'c');
  assert.equal(cc.skillInfo(path.join(dir, 'missing')), null);
});
