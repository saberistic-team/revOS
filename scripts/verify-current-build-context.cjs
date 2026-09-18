// Isolated schema and synthetic data. No model, Kubernetes, or Forgejo calls.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

(async () => {
  const schema = 'current_build_context_check_' + Date.now();
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  let pool, activityContext, oldCurrent;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ['run', 'reasoning_session', 'reasoning_turn', 'run_feedback', 'code_build'])
      await admin.query(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    process.env.DATABASE_URL = url.toString();
    const dist = process.env.ENGINE_DIST || '/app/dist';
    pool = require(dist + '/packages/database/src').pool;
    const { ToolRegistry } = require(dist + '/packages/engine/src');
    const { sessionConfig } = require(dist + '/packages/engine/src/agent-policy');
    const { initialSessionState } = require(dist + '/packages/shared/src/session');
    const { createSessionActivities } = require(dist + '/packages/temporal/src/activities/sessions');
    activityContext = require('@temporalio/activity').Context;
    oldCurrent = activityContext.current;
    activityContext.current = () => ({ cancellationSignal: new AbortController().signal });

    const customerId = randomUUID(), otherCustomerId = randomUUID();
    const runId = randomUUID(), otherRunId = randomUUID(), sessionId = randomUUID(), buildId = randomUUID();
    const skillId = randomUUID(), startId = randomUUID(), reviseId = randomUUID(), inspectId = randomUUID();
    const snapshot = {
      config: sessionConfig({ allowHumanReview: true }), outputSchema: { type: 'object' },
      catalog: [{ id: skillId, name: 'Synthetic prototype skill', version: 1, description: 'Verify revision context', executionType: 'agent', instructions: 'Revise existing work', inputSchema: {}, outputSchema: {}, configuration: { allowedToolIds: [startId, reviseId, inspectId] } }],
      definition: {
        workflow: { id: randomUUID(), version: 1, goal: 'Synthetic revision', sopMarkdown: 'Revise and review', inputSchema: {}, outputSchema: {} },
        agent: { name: 'Fixture planner', instructions: 'No external calls' }, steps: [], knowledge: [],
        tools: [{ id: startId, handler: 'openhands.start_build', inputSchema: { type: 'object', required: ['brief'] }, outputSchema: {} }, { id: reviseId, handler: 'openhands.revise_build', inputSchema: { type: 'object', required: ['brief', 'buildId'] }, outputSchema: {} }, { id: inspectId, handler: 'openhands.inspect_build', inputSchema: { type: 'object', required: ['buildId'] }, outputSchema: {} }],
      },
    };
    for (const id of [runId, otherRunId])
      await pool.query('INSERT INTO run(id,task_id,workflow_version_id,temporal_workflow_id,customer_organization_id) VALUES($1,$2,$3,$4,$5)', [id, randomUUID(), randomUUID(), 'fixture:' + id, customerId]);
    await pool.query('INSERT INTO reasoning_session(id,run_id,workflow_step_id,snapshot) VALUES($1,$2,$3,$4)', [sessionId, runId, randomUUID(), JSON.stringify(snapshot)]);
    const state = { ...initialSessionState(), activeSkillId: skillId, revisionPending: true };
    const historicalDecision = { action: 'call_tool', target: inspectId, payload: JSON.stringify({ buildId }), summary: 'Read the earlier build result' };
    const historicalRequest = { sessionId, turn: 0, input: {}, state, events: [] };
    const historicalOutcome = { state, result: { id: buildId, state: 'failed', error: 'Old iteration-limit failure' } };
    await pool.query('INSERT INTO reasoning_turn(session_id,turn,request,decision,outcome) VALUES($1,0,$2,$3,$4)', [sessionId, JSON.stringify(historicalRequest), JSON.stringify(historicalDecision), JSON.stringify(historicalOutcome)]);
    const addBuild = (id, org, run, sourceKey, buildState, result = {}, error = null, updatedAt = '2026-09-17T12:00:00Z') =>
      pool.query('INSERT INTO code_build(id,organization_id,run_id,source_key,brief,state,result,error,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, org, run, sourceKey, 'PRIVATE_BRIEF_NOT_CONTEXT', buildState, JSON.stringify(result), error, updatedAt]);
    await addBuild(buildId, customerId, runId, sessionId + ':0', 'completed', { commit: 'saved-commit', previewUrl: 'http://localhost:3002/' + buildId + '/', codeUrl: 'http://localhost:3001/fixture/src/commit/saved-commit', events: ['PRIVATE_EVENTS_NOT_CONTEXT'] }, null, '2026-09-16T12:00:00Z');
    for (let i = 1; i <= 15; i++)
      await addBuild(randomUUID(), customerId, runId, sessionId + ':' + i, 'failed', { events: ['PRIVATE_EVENTS_NOT_CONTEXT'] }, 'x'.repeat(3000));
    const foreignCustomerBuild = randomUUID(), otherRunBuild = randomUUID(), siblingSessionBuild = randomUUID();
    await addBuild(foreignCustomerBuild, otherCustomerId, runId, sessionId + ':foreign-customer', 'completed');
    await addBuild(otherRunBuild, customerId, otherRunId, sessionId + ':other-run', 'completed');
    await addBuild(siblingSessionBuild, customerId, runId, randomUUID() + ':0', 'completed');
    const historicalBefore = (await pool.query('SELECT request,decision,outcome FROM reasoning_turn WHERE session_id=$1 AND turn=0', [sessionId])).rows[0];

    let generations = 0;
    const revision = { action: 'call_tool', target: reviseId, payload: JSON.stringify({ buildId, brief: 'Make the requested targeted change' }), summary: 'Revise the completed prototype' };
    const activities = createSessionActivities(new ToolRegistry(), { reason: async request => {
      generations++;
      assert.equal(request.currentBuilds.length, 13, 'Bound the newest list while retaining an older completed result');
      assert.ok(request.currentBuilds.some(build => build.id === buildId && build.state === 'completed' && build.commit === 'saved-commit'));
      for (const excluded of [foreignCustomerBuild, otherRunBuild, siblingSessionBuild])
        assert.ok(!request.currentBuilds.some(build => build.id === excluded), 'Build context must match customer, run, and session');
      for (const build of request.currentBuilds) {
        assert.deepEqual(Object.keys(build).sort(), ['codeUrl', 'commit', 'error', 'id', 'parentId', 'previewUrl', 'state', 'updatedAt']);
        assert.ok(!build.error || build.error.length <= 600);
      }
      assert.equal(request.events[0].result.state, 'failed', 'The historical failure remains part of the audit trail');
      assert.ok(!JSON.stringify(request.currentBuilds).includes('PRIVATE_'));
      if (generations === 1) return { action: 'call_tool', target: startId, payload: JSON.stringify({ brief: 'Incorrect fresh replacement' }), summary: 'Build again' };
      assert.match(request.validationFeedback.error, /openhands\.revise_build/);
      assert.match(request.validationFeedback.error, new RegExp(buildId));
      return revision;
    } });
    assert.deepEqual(await activities.reason({ sessionId, turn: 1 }), revision);
    assert.equal(generations, 2, 'Invalid fresh start must be corrected before any tool execution');
    const saved = (await pool.query('SELECT request,decision FROM reasoning_turn WHERE session_id=$1 AND turn=1', [sessionId])).rows[0];
    assert.equal(saved.request.currentBuilds.find(build => build.id === buildId).state, 'completed');
    assert.match(saved.request.validationFeedback.error, /openhands\.revise_build/);
    await pool.query("UPDATE code_build SET state='failed' WHERE id=$1", [buildId]);
    assert.deepEqual(await activities.reason({ sessionId, turn: 1 }), revision);
    assert.equal(generations, 2, 'A committed turn must return its original decision without refreshing or regenerating');
    assert.deepEqual((await pool.query('SELECT request,decision FROM reasoning_turn WHERE session_id=$1 AND turn=1', [sessionId])).rows[0], saved);
    assert.deepEqual((await pool.query('SELECT request,decision,outcome FROM reasoning_turn WHERE session_id=$1 AND turn=0', [sessionId])).rows[0], historicalBefore);
    console.log('PASS: current build scope, bounded metadata, older completed output retention, stale-history correction, persisted context, and immutable decision replay. No external tools or model calls.');
  } finally {
    if (activityContext && oldCurrent) activityContext.current = oldCurrent;
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
