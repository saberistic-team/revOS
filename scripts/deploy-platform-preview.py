#!/usr/bin/env python3
"""Add platform services and roll HTTP frontends without stopping existing workflow workers."""
import base64, copy, json, secrets, subprocess, sys, time
K=['kubectl','--context','docker-desktop','-n','agent-engine-local']
def get(kind,name): return json.loads(subprocess.check_output(K+['get',kind,name,'-o','json']))
def apply(value): subprocess.run(K+['apply','-f','-'],input=json.dumps(value),text=True,check=True,stdout=subprocess.DEVNULL)
def env(container, values):
    container['env']=[e for e in container.get('env',[]) if e['name'] not in values]+[{'name':k,'value':str(v)} for k,v in values.items()]
def deploy(name,spec):
    apply({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':name},'spec':{'replicas':1,'strategy':{'type':'RollingUpdate','rollingUpdate':{'maxUnavailable':0,'maxSurge':1}},'selector':{'matchLabels':{'app':name}},'template':{'metadata':{'labels':{'app':name}},'spec':spec}}})
def service(name,port): apply({'apiVersion':'v1','kind':'Service','metadata':{'name':name},'spec':{'selector':{'app':name},'ports':[{'port':port,'targetPort':port}]}})
def portal_environment(container, lookup=get):
    # Expand approved keys as references. Never inherit an entire Secret/ConfigMap:
    # a later provider credential added to a shared source must not reach this pod.
    allowed={'DATABASE_URL','TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_TLS','TEMPORAL_API_KEY','TEMPORAL_TASK_QUEUE','PARTICIPATION_TASK_QUEUE','PUBLIC_PORTAL_URL','CUSTOMER_PORTAL_ONLY','DISABLE_BACKGROUND_DISPATCH','PLATFORM_DISPATCH_ENABLED','PARTICIPATION_TOKEN_KEY','PORT','HOST','NODE_ENV'}
    approved={}
    for source in container.get('envFrom',[]):
        kind='secret' if 'secretRef' in source else 'configmap'
        ref=source.get('secretRef') or source.get('configMapRef')
        if not ref: continue
        try: resource=lookup(kind,ref['name'])
        except subprocess.CalledProcessError:
            if ref.get('optional'): continue
            raise
        for key in resource.get('data',{}):
            name=source.get('prefix','')+key
            if name not in allowed: continue
            field='secretKeyRef' if kind=='secret' else 'configMapKeyRef'
            approved[name]={'name':name,'valueFrom':{field:{'name':ref['name'],'key':key,'optional':ref.get('optional',False)}}}
    for entry in container.get('env',[]):
        if entry['name'] in allowed: approved[entry['name']]=copy.deepcopy(entry)
    container['env']=list(approved.values())
    container.pop('envFrom',None)
    return container

image=sys.argv[1] if len(sys.argv)>1 else 'agent-engine-api:platform-v1'
worker_image=sys.argv[2] if len(sys.argv)>2 else 'agent-engine-worker:platform-v1'
common={'TEMPORAL_TASK_QUEUE':'agent-engine-platform','PARTICIPATION_TASK_QUEUE':'agent-engine-platform','PUBLIC_PORTAL_URL':'http://localhost:3005/customer','MAIL_DELIVERY_MODE':'local','SMTP_HOST':'mailpit.agent-engine-local.svc.cluster.local','SMTP_PORT':'1025','SMTP_FROM':'onboarding@revos.local'}
secret_exists=subprocess.run(K+['get','secret','participation-secrets'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if not secret_exists: apply({'apiVersion':'v1','kind':'Secret','metadata':{'name':'participation-secrets'},'type':'Opaque','stringData':{'PARTICIPATION_TOKEN_KEY':base64.b64encode(secrets.token_bytes(32)).decode()}})
api=copy.deepcopy(get('deployment','api')['spec']['template']['spec'])
worker=copy.deepcopy(get('deployment','worker')['spec']['template']['spec'])
for spec,img in [(api,image),(worker,worker_image)]:
    c=spec['containers'][0];c['image']=img
    env(c,common)
    c['envFrom']=[e for e in c.get('envFrom',[]) if e.get('secretRef',{}).get('name') not in ['participation-secrets','delivery-platform-secret'] and e.get('configMapRef',{}).get('name')!='kelos-platform-config']+[{'secretRef':{'name':'participation-secrets'}},{'secretRef':{'name':'delivery-platform-secret','optional':True}}]
# Preserve the separately installed Kelos executor without importing CI permissions.
kelos_enabled=subprocess.run(K+['get','configmap','kelos-platform-config'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if kelos_enabled:
    worker['serviceAccountName']='engine-platform-worker'
    worker['automountServiceAccountToken']=True
    worker['containers'][0]['envFrom'].append({'configMapRef':{'name':'kelos-platform-config'}})
# New activities and all future launches have their own queue. Old workers keep current executions.
worker['containers'][0]['name']='worker'
env(worker['containers'][0],{'OPENHANDS_IMAGE':'agent-engine-openhands:platform-budget-v2'})
job=copy.deepcopy(api['containers'][0])
for key in ['ports','startupProbe','readinessProbe','livenessProbe','volumeMounts']: job.pop(key,None)
job['command']=['node','dist/scripts/migrate.js']
name='platform-migrate-'+str(int(time.time()))
apply({'apiVersion':'batch/v1','kind':'Job','metadata':{'name':name},'spec':{'ttlSecondsAfterFinished':3600,'backoffLimit':0,'template':{'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'containers':[job]}}}})
subprocess.run(K+['wait','--for=condition=complete','job/'+name,'--timeout=60s'],check=True)
deploy('worker-platform',worker)
next_api=copy.deepcopy(api);env(next_api['containers'][0],{'DISABLE_BACKGROUND_DISPATCH':'true','PLATFORM_DISPATCH_ENABLED':'true','CUSTOMER_PORTAL_ONLY':'false'})
next_api['serviceAccountName']='engine-build-worker';next_api['automountServiceAccountToken']=True
if kelos_enabled: next_api['containers'][0]['envFrom'].append({'configMapRef':{'name':'kelos-platform-config'}})
deploy('api-next',next_api);service('api-next',3000)
portal=copy.deepcopy(api);env(portal['containers'][0],{'DISABLE_BACKGROUND_DISPATCH':'true','PLATFORM_DISPATCH_ENABLED':'false','CUSTOMER_PORTAL_ONLY':'true'})
portal['automountServiceAccountToken']=False
portal.pop('serviceAccountName',None)
portal.pop('volumes',None);portal['containers'][0].pop('volumeMounts',None)
# Portal receives database/Temporal configuration and its invitation key only, never provider/repository credentials.
portal_environment(portal['containers'][0])
deploy('customer-portal',portal);service('customer-portal',3000)
# Keep the existing pages and a single legacy dispatcher; route new work to updated workers.
# maxUnavailable=0 keeps an HTTP-ready pod available during this backend upgrade.
env(api['containers'][0],{'DISABLE_BACKGROUND_DISPATCH':'false','PLATFORM_DISPATCH_ENABLED':'false','CUSTOMER_PORTAL_ONLY':'false'})
if kelos_enabled: api['containers'][0]['envFrom'].append({'configMapRef':{'name':'kelos-platform-config'}})
api['automountServiceAccountToken']=True;api['serviceAccountName']='engine-build-worker'
deploy('api',api)
print('Applied platform worker, preview API, isolated customer portal and compatible HTTP backend. Existing worker unchanged.')
