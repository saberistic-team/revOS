// Read-only verification of the existing organizations. Does not create runs, products, keys or usage.
const assert=require('node:assert/strict');
const base=process.env.API_URL||'http://localhost:3004';
const organizations=[
  ['revOS','cd698cc7-48d0-4df0-a118-ac0bc6b647b8'],
  ['NYC Luxury','b6f50b59-ff25-4f21-be01-e9986be4d3f3'],
  ['SG Homes','681815cd-1c45-4d53-8c11-23d2cfa0acff'],
];
async function read(path){const response=await fetch(base+path,{signal:AbortSignal.timeout(15000)});assert(response.ok,`${path}: HTTP ${response.status}`);return response.json();}
async function main(){
  await read('/ready');
  for(const [name,org] of organizations){
    const prefix='/organizations/'+org+'/platform';
    const [products,campaigns,usage,collection]=await Promise.all([read(prefix+'/products'),read(prefix+'/campaigns'),read(prefix+'/usage'),read(prefix+'/usage/collection')]);
    assert(Array.isArray(products)&&Array.isArray(campaigns));
    assert(usage.events.every(e=>e.organization_id===org),'Usage tenancy');
    assert(products.every(p=>p.organization_id===org),'Product tenancy');
    assert(campaigns.every(c=>c.organization_id===org),'Campaign tenancy');
    let healthyDeployments=0;
    for(const product of products){
      const detail=await read(prefix+'/products/'+product.id);
      assert.equal(detail.id,product.id);assert.equal(detail.organization_id,org);
      assert(detail.campaigns.every(c=>c.organization_id===org&&c.product_id===product.id));
      const deployment=await read('/products/'+product.id+'/service-delivery');
      const ready=deployment.releases.filter(r=>r.state==='healthy');healthyDeployments+=ready.length;
      if(product.live_url)assert(ready.some(r=>r.environment==='live'&&r.url===product.live_url),'Live link must have a healthy release');
      if(product.preview_url&&!detail.releases.some(r=>r.state==='completed'&&r.result?.previewUrl===product.preview_url))assert(ready.some(r=>r.environment==='preview'&&r.url===product.preview_url),'Backend preview link must have a healthy release');
    }
    console.log(JSON.stringify({organization:name,products:products.length,campaigns:campaigns.length,usageEvents:usage.events.length,unpricedEvents:usage.groups.reduce((s,g)=>s+g.unpriced_events,0),storageSamples:collection.storageSamples.length,healthyDeployments,collectionError:collection.configuration.last_error||null}));
  }
  const invoices=await fetch(base+'/organizations/'+organizations[0][1]+'/platform/invoices');assert.equal(invoices.status,404,'No invoice API is exposed');
  console.log('Product platform read-only checks passed.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
