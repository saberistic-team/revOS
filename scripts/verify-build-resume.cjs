// Isolated schema + temporary files. Kubernetes and Forgejo are stubbed; no model calls.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
(async () => {
  const schema = 'build_resume_check_' + Date.now();
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const folder = await fs.mkdtemp('/tmp/revos-build-resume-');
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.code_build (LIKE public.code_build INCLUDING ALL)`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    process.env.DATABASE_URL = url.toString();
    process.env.BUILD_DATA_DIR = folder;
    process.env.OPENHANDS_MAX_ITERATIONS = '200';
    const dist = process.env.ENGINE_DIST || '/app/dist';
    pool = require(dist + '/packages/database/src').pool;
    const k8s = require(dist + '/packages/engine/src/kubernetes');
    const git = require(dist + '/packages/engine/src/forgejo');
    let priorActive = true, currentJob = null, creates = 0, calls = 0;
    k8s.kubernetes = async (name, method, body) => {
      calls++;
      if (method === 'POST') { creates++; currentJob = { ...body, status: { active: 1 } }; return currentJob; }
      return name.endsWith('-r1') ? currentJob : { status: priorActive ? { active: 1 } : { failed: 1 } };
    };
    const fixtureCommit = 'a'.repeat(40), emptyCommit = 'b'.repeat(40);
    const content = Buffer.from('<html>Preserved</html>');
    const blobSha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    let published = false;
    git.forgejo = async (name, method, body) => {
      if (name.endsWith('/contents') && method === 'POST') {
        assert.deepEqual(body.files, [{ operation: 'create', path: 'index.html', content: content.toString('base64') }]);
        published = true;
        return { commit: { sha: fixtureCommit } };
      }
      if (name.includes('/git/trees/')) return { tree: name.includes(fixtureCommit) ? [{ type: 'blob', mode: '100644', path: 'index.html', sha: blobSha, size: content.length }] : [], truncated: false };
      if (name.includes('/branches/')) return { commit: { id: published ? fixtureCommit : emptyCommit } };
      return { id: 1 };
    };
    const { resumeCodeBuild, tickCodeBuild } = require(dist + '/packages/engine/src/code-builds');
    const id = randomUUID(), requestId = randomUUID();
    await pool.query("INSERT INTO code_build(id,organization_id,source_key,brief,state,error) VALUES($1,$2,$3,'Synthetic resume fixture','failed','Iteration limit')", [id, randomUUID(), 'fixture:' + id]);
    const workspace = path.join(folder, 'jobs', id);
    await fs.mkdir(path.join(workspace, 'site'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'site', 'index.html'), '<html>Preserved</html>');
    await fs.writeFile(path.join(workspace, 'request.json'), JSON.stringify({ id, brief: 'Synthetic resume fixture' }));
    await fs.writeFile(path.join(workspace, 'result.json'), JSON.stringify({ state: 'failed' }));
    await fs.writeFile(path.join(workspace, 'progress.json'), JSON.stringify({ phase: 'failed' }));
    const [a, b] = await Promise.all([resumeCodeBuild(id, requestId), resumeCodeBuild(id, requestId)]);
    assert.equal(a.result._retry.attempt, 1);
    assert.equal(b.result._retry.attempt, 1);
    await assert.rejects(resumeCodeBuild(id, randomUUID()), /Only a failed/);
    assert.equal(await tickCodeBuild(id, 0), true);
    assert.equal(calls, 0, 'Old attempt must be fenced before provider/file effects');
    assert.equal(await tickCodeBuild(id, 1), false);
    assert.equal(creates, 0, 'Prior coding process must finish first');
    assert.equal(JSON.parse(await fs.readFile(path.join(workspace, 'result.json'))).state, 'failed');
    priorActive = false;
    assert.equal(await tickCodeBuild(id, 1), false);
    assert.equal(creates, 1);
    const request = JSON.parse(await fs.readFile(path.join(workspace, 'request.json')));
    assert.equal(request.resume, true);
    assert.equal(request.attempt, 1);
    assert.equal(request.maxIterations, 200);
    assert.equal(currentJob.spec.activeDeadlineSeconds, 7200);
    assert.equal(await fs.readFile(path.join(workspace, 'site', 'index.html'), 'utf8'), '<html>Preserved</html>');
    await assert.rejects(fs.stat(path.join(workspace, 'result.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await fs.readFile(path.join(workspace, 'attempts', '0', 'result.json'))).state, 'failed');
    await tickCodeBuild(id, 1);
    assert.equal(creates, 1, 'Polling must not launch another job');
    currentJob.status = { succeeded: 1 };
    await fs.writeFile(path.join(workspace, 'result.json'), JSON.stringify({ state: 'completed' }));
    assert.equal(await tickCodeBuild(id, 1), true);
    const completed = (await pool.query('SELECT * FROM code_build WHERE id=$1', [id])).rows[0];
    assert.equal(completed.state, 'completed');
    assert.equal(completed.result._retry.requestId, requestId);
    assert.equal(completed.result.commit, fixtureCommit);
    assert.equal((await resumeCodeBuild(id, requestId)).state, 'completed', 'Lost-response retry remains idempotent after completion');

    // An attempt can fail before its Job exists. A later attempt must still
    // wait for the original process, rather than checking only its predecessor.
    const gapId = randomUUID(), firstRequest = randomUUID(), secondRequest = randomUUID();
    await pool.query("INSERT INTO code_build(id,organization_id,source_key,brief,state,error) VALUES($1,$2,$3,'Skipped attempt fixture','failed','Provider lookup failed')", [gapId, randomUUID(), 'fixture:' + gapId]);
    const gapWorkspace = path.join(folder, 'jobs', gapId);
    await fs.mkdir(path.join(gapWorkspace, 'site'), { recursive: true });
    await fs.writeFile(path.join(gapWorkspace, 'request.json'), JSON.stringify({ id: gapId, brief: 'Skipped attempt fixture' }));
    await fs.writeFile(path.join(gapWorkspace, 'result.json'), JSON.stringify({ state: 'failed' }));
    let oldestActive = true, gapJob = null, gapCreates = 0;
    k8s.kubernetes = async (name, method, body) => {
      if (method === 'POST') { gapCreates++; gapJob = { ...body, status: { active: 1 } }; return gapJob; }
      if (name.endsWith('build-' + gapId)) return { status: oldestActive ? { active: 1 } : { failed: 1 } };
      return name.endsWith('-r2') ? gapJob : null;
    };
    await resumeCodeBuild(gapId, firstRequest);
    assert.equal(await tickCodeBuild(gapId, 1), false);
    await pool.query("UPDATE code_build SET state='failed',error='Temporary provider lookup failure' WHERE id=$1", [gapId]);
    assert.equal((await resumeCodeBuild(gapId, secondRequest)).result._retry.attempt, 2);
    assert.equal(await tickCodeBuild(gapId, 2), false);
    assert.equal(gapCreates, 0, 'A missing intervening Job must not hide an older active coding process');
    assert.equal(JSON.parse(await fs.readFile(path.join(gapWorkspace, 'result.json'))).state, 'failed', 'Waiting must preserve existing attempt files');
    oldestActive = false;
    assert.equal(await tickCodeBuild(gapId, 2), false);
    assert.equal(gapCreates, 1);
    assert.equal(gapJob.metadata.name, 'build-' + gapId + '-r2');
    assert.equal(JSON.parse(await fs.readFile(path.join(gapWorkspace, 'attempts', '0', 'result.json'))).state, 'failed', 'Archive metadata under the attempt that actually wrote it');
    await pool.query("UPDATE code_build SET state='failed',error='Second attempt failed' WHERE id=$1", [gapId]);
    const historicalReplay = await resumeCodeBuild(gapId, firstRequest);
    assert.equal(historicalReplay.result._retry.attempt, 2, 'Delayed duplicate of an older request must not create another paid attempt');
    assert.equal(historicalReplay.state, 'failed');
    console.log('PASS: idempotent resume including historical requests, all-prior-attempt exclusion, stale activity fencing, preserved files, archived results, configured limits, one job per attempt, and retained retry history.');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await fs.rm(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
