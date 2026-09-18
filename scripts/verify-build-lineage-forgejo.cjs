// Local Forgejo integration check. Creates and removes its own private fixture
// repository; never reads or changes customer repositories or calls a model.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
(async () => {
  const dist = process.env.ENGINE_DIST || '/app/dist';
  const { forgejo } = require(dist + '/packages/engine/src/forgejo');
  const { committedBuildSource, publishBuildSource } = require(dist + '/packages/engine/src/build-lineage');
  const name = 'revos-lineage-check-' + randomUUID();
  const owner = process.env.FORGEJO_OWNER || 'revos';
  const api = '/repos/' + encodeURIComponent(owner) + '/' + name;
  let created = false;
  try {
    await forgejo('/user/repos', 'POST', { name, private: true, auto_init: true, default_branch: 'main' });
    created = true;
    const main = (await forgejo(api + '/branches/main')).commit.id;
    const file = (name, text) => ({ name, data: Buffer.from(text) });
    const original = [file('index.html', '<h1>Original fixture</h1>'), file('assets/styles.css', 'body{color:blue}'), file('obsolete.txt', 'Remove only in revision')];
    const parent = await publishBuildSource(api, 'build-parent', 'main', original, forgejo);
    assert.deepEqual((await committedBuildSource(api, parent, forgejo)).map(f => [f.name, f.data.toString()]).sort(), original.map(f => [f.name, f.data.toString()]).sort());
    const revised = [file('index.html', '<h1>Revised fixture</h1>'), original[1], file('CHECKLIST.md', 'Targeted checks passed')];
    const commit = await publishBuildSource(api, 'build-revision', parent, revised, forgejo);
    const saved = await forgejo(api + '/git/commits/' + commit);
    assert.ok(saved.parents.some(p => p.sha === parent), 'Revision commit must directly descend from pinned parent');
    assert.deepEqual((await committedBuildSource(api, commit, forgejo)).map(f => [f.name, f.data.toString()]).sort(), revised.map(f => [f.name, f.data.toString()]).sort());
    assert.equal(await publishBuildSource(api, 'build-revision', parent, revised, forgejo), commit, 'Lost-response retry must reuse identical revision');
    assert.equal((await forgejo(api + '/branches/build-parent')).commit.id, parent, 'Original version remains unchanged');
    assert.equal((await forgejo(api + '/branches/main')).commit.id, main, 'Main remains unchanged');
    console.log('PASS: exact committed source, parent Git ancestry, additions/updates/deletions, repeat publication, and original version preservation.');
  } finally {
    if (created) await forgejo(api, 'DELETE');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
