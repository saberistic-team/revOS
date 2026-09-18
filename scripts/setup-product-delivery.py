#!/usr/bin/env python3
"""Configure additive local delivery services. Never restart the original API/worker.

Prerequisites: approved local Docker socket relay used by OpenHands, official
ArgoCD/cert-manager/Kelos installed, revos-product-runner:13.1.0 built locally.
Credentials are passed in memory to Kubernetes; no credential value is printed.
"""
import argparse, base64, json, pathlib, secrets, subprocess, urllib.request

K=['kubectl','--context','docker-desktop']
NS='agent-engine-local'
ROOT=pathlib.Path(__file__).resolve().parent.parent
def run(*args, data=None):
    return subprocess.run(K+list(args),input=data,text=True,capture_output=True,check=True).stdout
def apply(value):
    run('apply','-f','-',data=json.dumps(value))
def secret(name,namespace=NS):
    try:
        d=json.loads(run('-n',namespace,'get','secret',name,'-o','json'))
        return {k:base64.b64decode(v).decode() for k,v in d['data'].items()}
    except subprocess.CalledProcessError: return None
def save_secret(name,values,namespace=NS,labels=None):
    apply({'apiVersion':'v1','kind':'Secret','metadata':{'name':name,'namespace':namespace,**({'labels':labels} if labels else {})},'type':'Opaque','stringData':values})
def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--engine-service-account',default='engine-build-worker'); args=parser.parse_args()
    connection=secret('forgejo-secrets')
    if not connection: raise SystemExit('Initialize local Forgejo first')
    for file in ('builder-rbac.yaml','argocd-project.yaml','database-rbac.yaml'):
        content=(ROOT/'infrastructure/kubernetes/product-runtime'/file).read_text().replace('name: agent-engine\n','name: '+args.engine_service_account+'\n')
        run('apply','-f','-',data=content)
    cfg=secret('delivery-platform-secret') or {}
    cfg.setdefault('SERVICE_DELIVERY_CALLBACK_KEY',secrets.token_hex(32))
    cfg.update({'SERVICE_DELIVERY_CALLBACK_URL':'http://api-next.agent-engine-local.svc.cluster.local:3000',
                'PRODUCT_IMAGE_REGISTRY':'localhost:5050/revos','PRODUCT_CI_RUNNER_LABEL':'revos-product-builder',
                'FORGEJO_GITOPS_URL':'http://forgejo.agent-engine-local.svc.cluster.local:3000',
                'FORGEJO_CI_URL':'http://forgejo.agent-engine-local.svc.cluster.local:3000',
                'KELOS_ENABLED':'true','KELOS_OPENHANDS_IMAGE':'agent-engine-openhands-kelos:platform-budget-v3',
                'OPENHANDS_IMAGE':'agent-engine-openhands:platform-budget-v2'})
    save_secret('delivery-platform-secret',cfg)
    if not secret('revos-delivery-repository','argocd'):
        token=run('-n',NS,'exec','deployment/forgejo','--','su','git','-c','forgejo admin user generate-access-token --username revos --token-name revos-argocd-delivery --scopes read:repository --raw').strip().splitlines()[-1]
        save_secret('revos-delivery-repository',{'type':'git','url':'http://forgejo.agent-engine-local.svc.cluster.local:3000/revos','username':'revos','password':token},'argocd',{'argocd.argoproj.io/secret-type':'repo-creds'})
    registration=secret('product-ci-runner')
    if not registration:
        request=urllib.request.Request('http://localhost:3001/api/v1/user/actions/runners',data=json.dumps({'name':'revos-product-builder','description':'Local product CI; approved Docker Desktop socket'}).encode(),headers={'Authorization':'token '+connection['FORGEJO_TOKEN'],'Content-Type':'application/json'},method='POST')
        registered=json.load(urllib.request.urlopen(request,timeout=30))
        configuration={'log':{'level':'info'},'runner':{'capacity':1,'labels':['revos-product-builder:host'],'timeout':'1h','envs':{'DOCKER_HOST':'unix:///var/run/docker.sock'}},'cache':{'enabled':False},'host':{'workdir_parent':'/data/jobs'},'server':{'connections':{'forgejo':{'url':'http://forgejo:3000','uuid':registered['uuid'],'token':registered['token']}}}}
        save_secret('product-ci-runner',{'runner.json':json.dumps(configuration)})
    apply({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'product-ci-runner','namespace':NS},'spec':{'replicas':1,'selector':{'matchLabels':{'app':'product-ci-runner'}},'template':{'metadata':{'labels':{'app':'product-ci-runner'}},'spec':{'nodeSelector':{'kubernetes.io/hostname':'desktop-worker'},'automountServiceAccountToken':False,'containers':[{'name':'runner','image':'revos-product-runner:13.1.0','imagePullPolicy':'IfNotPresent','volumeMounts':[{'name':'config','mountPath':'/config','readOnly':True},{'name':'data','mountPath':'/data'},{'name':'docker','mountPath':'/var/run/docker.sock'}],'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'2','memory':'1Gi'}}}],'volumes':[{'name':'config','secret':{'secretName':'product-ci-runner'}},{'name':'data','emptyDir':{}},{'name':'docker','hostPath':{'path':'/var/lib/revos-docker/docker.sock','type':'Socket'}}]}}}})
    print('Delivery services configured. New API/worker may read envFrom secret/delivery-platform-secret. Original deployments were not changed.')
if __name__=='__main__': main()
