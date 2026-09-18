// Run inside the preview API container: node < scripts/verify-next-preview.cjs
// Saved selections are read only. Metadata concurrency checks run in a rolled-back transaction.
const assert = require('node:assert/strict');
const { pool } = require('./dist/packages/database/src');
const { resolveAssistantContext } = require('./dist/packages/engine/src/assistant-context');
async function main() {
  const run = (await pool.query(`SELECT r.id,t.workflow_id,t.organization_id,r.workflow_version_id,r.execution_definition,a.id AS attempt_id,a.engagement_id,a.stage_index FROM run r JOIN task t ON t.id=r.task_id LEFT JOIN engagement_attempt a ON a.run_id=r.id ORDER BY r.created_at DESC LIMIT 1`)).rows[0];
  assert(run);
  const resolved = await resolveAssistantContext(run.organization_id,'run',{kind:'run',runId:run.id,workflowId:run.workflow_id,workflowStepId:run.execution_definition.steps[0]?.id,engagementId:run.engagement_id,attemptId:run.attempt_id,stageIndex:run.stage_index,version:run.workflow_version_id});
  assert.equal(resolved.details.run.id,run.id);
  const doc = (await pool.query('SELECT id,organization_id,revision FROM kb_document ORDER BY updated_at DESC LIMIT 1')).rows[0];
  if(doc){await resolveAssistantContext(doc.organization_id,'knowledge',{kind:'document',documentId:doc.id,version:doc.revision});await assert.rejects(()=>resolveAssistantContext(doc.organization_id,'knowledge',{documentId:doc.id,version:doc.revision+1}),/changed/);}
  const skill = (await pool.query('SELECT v.id,v.version,s.organization_id FROM skill_version v JOIN skill s ON s.id=v.skill_id WHERE s.organization_id IS NOT NULL ORDER BY v.created_at DESC LIMIT 1')).rows[0];
  if(skill)await resolveAssistantContext(skill.organization_id,'library',{skillVersionId:skill.id,version:skill.version});
  const chain = (await pool.query('SELECT id,organization_id,revision FROM engagement_template LIMIT 1')).rows[0];
  if(chain)await resolveAssistantContext(chain.organization_id,'library',{chainId:chain.id,draftRevision:chain.revision});
  const product = (await pool.query('SELECT id,organization_id FROM code_build WHERE parent_id IS NULL LIMIT 1')).rows[0];
  if(product){await resolveAssistantContext(product.organization_id,'knowledge',{productId:product.id,buildId:product.id});
    const connection=await pool.connect();
    try{await connection.query('BEGIN');
      const existing=(await connection.query('SELECT revision FROM product_metadata WHERE product_id=$1',[product.id])).rows[0];
      if(!existing){
        const inserted=await connection.query('INSERT INTO product_metadata(product_id,organization_id,name,description) VALUES($1,$2,$3,$4) ON CONFLICT(product_id) DO NOTHING RETURNING revision',[product.id,product.organization_id,'Isolated verification','Rolled back']);assert.equal(inserted.rows[0].revision,1);
        const updated=await connection.query('UPDATE product_metadata SET name=$3,description=$4,revision=revision+1,updated_at=now() WHERE product_id=$1 AND organization_id=$2 AND revision=$5 RETURNING revision',[product.id,product.organization_id,'Updated verification','Rolled back',1]);assert.equal(updated.rows[0].revision,2);
        const stale=await connection.query('UPDATE product_metadata SET name=$3 WHERE product_id=$1 AND organization_id=$2 AND revision=$4',[product.id,product.organization_id,'Stale edit',1]);assert.equal(stale.rowCount,0);
      }
    }finally{await connection.query('ROLLBACK');connection.release();}
  }
  console.log('Saved run, document, skill, chain and product contexts verified. Metadata revision check rolled back.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end());
