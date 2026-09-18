"""Create a dedicated scoped Forgejo token and configure canvas sandboxes.
Credentials are passed through Kubernetes secrets, never printed or saved here.
"""
import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
prefix=['kubectl','--context','docker-desktop','-n','agent-engine-local']
def call(args,**kw):return subprocess.run(prefix+args,check=True,capture_output=True,text=True,**kw).stdout
name='openhands-forgejo'
check=subprocess.run(prefix+['get','secret',name,'-o','json'],capture_output=True,text=True)
if check.returncode:
    token=call(['exec','deployment/forgejo','--','su','git','-c','forgejo admin user generate-access-token --username revos --token-name openhands-canvas --scopes write:repository,read:user --raw']).strip().splitlines()[-1]
    if not token or ' ' in token:raise RuntimeError('Token creation failed')
    manifest={'apiVersion':'v1','kind':'Secret','metadata':{'name':name},'type':'Opaque','stringData':{'OH_AGENT_SERVER_ENV':json.dumps({'FORGEJO_TOKEN':token})}}
    call(['apply','-f','-'],input=json.dumps(manifest))
    print('Created dedicated repository-scoped OpenHands credential.')
else:print('Preserving existing OpenHands Forgejo credential.')
call(['apply','-f',str(root/'infrastructure/kubernetes/local/openhands-web.yaml')])
call(['rollout','status','deployment/openhands-web','--timeout=180s'])
# Configure through the supported API; preserve other providers without exposing tokens.
configure = r"""
import json,os,urllib.request
base='http://localhost:3000/api/v1'
with urllib.request.urlopen(base+'/settings',timeout=30) as response:
    settings=json.load(response)
providers={name:{'host':host} for name,host in (settings.get('provider_tokens_set') or {}).items()}
providers['forgejo']={'token':json.loads(os.environ['OH_AGENT_SERVER_ENV'])['FORGEJO_TOKEN'],'host':'http://host.docker.internal:3001'}
request=urllib.request.Request(base+'/secrets/git-providers',data=json.dumps({'provider_tokens':providers}).encode(),headers={'Content-Type':'application/json'},method='POST')
with urllib.request.urlopen(request,timeout=60) as response:
    assert response.status==200
print('Native Forgejo provider enabled; refresh OpenHands to select a repository.')
"""
print(call(['exec','-i','deployment/openhands-web','--','/app/.venv/bin/python','-'],input=configure).strip())
