#!/usr/bin/env python3
"""Deploy a separate local preview using the current API configuration, without restarting it."""
import copy, json, subprocess, sys, time
K = ['kubectl', '--context', 'docker-desktop', '-n', 'agent-engine-local']
def call(*args, **kw):
    return subprocess.run(K + list(args), check=True, **kw)
def apply(value):
    call('apply', '-f', '-', input=json.dumps(value), text=True)
image = sys.argv[1] if len(sys.argv) > 1 else 'agent-engine-api:next-ui'
source = json.loads(subprocess.check_output(K + ['get', 'deployment', 'api', '-o', 'json']))
spec = copy.deepcopy(source['spec']['template']['spec'])
container = spec['containers'][0]
container['image'] = image
container['env'] = [e for e in container.get('env', []) if e['name'] != 'DISABLE_BACKGROUND_DISPATCH'] + [{'name':'DISABLE_BACKGROUND_DISPATCH','value':'true'}]
spec['automountServiceAccountToken'] = False
# Only a new, additive table is introduced by this release. Drizzle records applied migrations.
migration = copy.deepcopy(container)
for key in ['ports', 'startupProbe', 'readinessProbe', 'livenessProbe', 'volumeMounts']:
    migration.pop(key, None)
migration['command'] = ['node', 'dist/scripts/migrate.js']
job_name = 'api-next-migrate-' + str(int(time.time()))
apply({'apiVersion':'batch/v1','kind':'Job','metadata':{'name':job_name},'spec':{'ttlSecondsAfterFinished':3600,'backoffLimit':0,'template':{'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'containers':[migration]}}}})
call('wait','--for=condition=complete','job/'+job_name,'--timeout=45s')
apply({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'api-next'},'spec':{'replicas':1,'selector':{'matchLabels':{'app':'api-next'}},'template':{'metadata':{'labels':{'app':'api-next'}},'spec':spec}}})
apply({'apiVersion':'v1','kind':'Service','metadata':{'name':'api-next'},'spec':{'selector':{'app':'api-next'},'ports':[{'port':3000,'targetPort':3000}]}})
call('rollout','status','deployment/api-next','--timeout=45s')
print('Preview API ready. Forward service/api-next 3004:3000 to use http://localhost:3004/next')
