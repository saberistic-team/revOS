#!/usr/bin/env python3
"""Enable only namespaced Kelos coding execution on the isolated platform worker.

Does not run setup-product-delivery or create CI/deployment credentials/roles.
Requires the official Kelos CRD/controller and locally built OpenHands adapter.
"""
import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parent.parent
K=['kubectl','--context','docker-desktop','-n','agent-engine-local']
def main():
 subprocess.run(K+['get','crd','tasks.kelos.dev','-o','name'],check=True)
 subprocess.run(K+['apply','-f',str(ROOT/'infrastructure/kubernetes/product-runtime/kelos-platform.yaml')],check=True)
 cfg=json.loads(subprocess.check_output(K+['get','configmap','kelos-platform-config','-o','json']))['data']
 fingerprint=hashlib.sha256(json.dumps(cfg,sort_keys=True).encode()).hexdigest()
 patch={'spec':{'template':{'spec':{'serviceAccountName':'engine-platform-worker','automountServiceAccountToken':True}}}}
 patch['spec']['template']['metadata']={'annotations':{'revos.kelos-config':fingerprint}}
 worker=json.loads(subprocess.check_output(K+['get','deployment','worker-platform','-o','json']))
 c=worker['spec']['template']['spec']['containers'][0]
 sources=[x for x in c.get('envFrom',[]) if x.get('configMapRef',{}).get('name')!='kelos-platform-config']
 sources.append({'configMapRef':{'name':'kelos-platform-config'}})
 patch['spec']['template']['spec']['containers']=[{'name':c['name'],'envFrom':sources,'env':[{'name':'OPENHANDS_IMAGE','value':'agent-engine-openhands:platform-budget-v2'}]}]
 subprocess.run(K+['patch','deployment','worker-platform','--type=strategic','-p',json.dumps(patch)],check=True)
 for name in ('api','api-next'):
  resource=json.loads(subprocess.check_output(K+['get','deployment',name,'-o','json']))
  c=resource['spec']['template']['spec']['containers'][0]
  sources=[x for x in c.get('envFrom',[]) if x.get('configMapRef',{}).get('name')!='kelos-platform-config']+[{'configMapRef':{'name':'kelos-platform-config'}}]
  # API availability reporting changes only environment configuration, never its account or permissions.
  update={'spec':{'template':{'metadata':{'annotations':{'revos.kelos-config':fingerprint}},'spec':{'containers':[{'name':c['name'],'envFrom':sources}]}}}}
  subprocess.run(K+['patch','deployment',name,'--type=strategic','-p',json.dumps(update)],check=True)
 print('Kelos executor enabled on worker-platform; availability configured on API/api-next. Original worker and all API permissions unchanged. Portal unchanged.')
if __name__=='__main__':main()
