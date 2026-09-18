/** Render a synthetic local runtime without installing CI credentials or permissions. */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { renderRuntime } from '../packages/engine/src/service-delivery';
import { serviceConfigSchema, immutableImage } from '../packages/shared/src/service-delivery';
async function main() {
  const {values}=parseArgs({options:{input:{type:'string'},image:{type:'string'},output:{type:'string'},host:{type:'string',default:'backend-fixture.localhost'},'ingress-class':{type:'string',default:'revos-products'},'public-port':{type:'string',default:'3006'}}});
  if(!values.input || !values.image || !values.output) throw Error('Usage: node --import tsx scripts/verify-backend-runtime.ts --input fixture.json --image REGISTRY/IMAGE@sha256:DIGEST --output runtime.json [--host backend-fixture.localhost] [--ingress-class revos-products]');
  const identity=z.object({productId:z.uuid(),organizationId:z.uuid()}).strict().parse(JSON.parse(await readFile(values.input,'utf8')));
  const configuration=serviceConfigSchema.parse({provider:'external_gitops',previewHost:values.host,publicPort:Number(values['public-port']),ingressClass:values['ingress-class'],database:{secret:'product-database'},migrationCommand:['python','migrate.py']});
  const rendered=renderRuntime({...identity,releaseId:randomUUID(),environment:'preview',image:immutableImage.parse(values.image),configuration});
  await writeFile(values.output,JSON.stringify({apiVersion:'v1',kind:'List',items:rendered.resources},null,2));
  console.log(JSON.stringify({namespace:rendered.namespace,url:rendered.url,manifest:values.output,note:'Rendered only; this does not claim a deployed release.'}));
}
main().catch(e=>{console.error(e.message);process.exit(1);});
