"""Initialize the private local Forgejo service; credentials stay in Kubernetes secrets."""
import json, subprocess, secrets, base64
NS='agent-engine-local'
def kubectl(*args, data=None):
    return subprocess.run(['kubectl','-n',NS,*args],input=data,text=True,capture_output=True,check=True).stdout
def apply_secret(name,values):
    kubectl('apply','-f','-',data=json.dumps({'apiVersion':'v1','kind':'Secret','metadata':{'name':name},'type':'Opaque','stringData':values}))
try:
    existing=json.loads(kubectl('get','secret','forgejo-secrets','-o','json'))
    print('Forgejo connection secret already exists; preserving credentials.')
except subprocess.CalledProcessError:
    password=secrets.token_urlsafe(32)
    # Feed generated credentials to the remote process without printing them.
    script='read -r BOOTSTRAP_PASSWORD; export BOOTSTRAP_PASSWORD; su git -c \'forgejo admin user create --username revos --password "$BOOTSTRAP_PASSWORD" --email revos@localhost.invalid --admin --must-change-password=false\''
    out=subprocess.run(['kubectl','-n',NS,'exec','-i','deployment/forgejo','--','sh','-c',script],input=password+'\n',capture_output=True,text=True)
    if out.returncode and 'already exists' not in out.stdout+out.stderr:raise RuntimeError('Forgejo account setup failed: '+out.stderr[:300])
    token=kubectl('exec','deployment/forgejo','--','su','git','-c','forgejo admin user generate-access-token --username revos --token-name revos-engine --scopes write:repository,write:user --raw').strip().splitlines()[-1]
    if not token or ' ' in token:raise RuntimeError('Could not create Forgejo service token')
    apply_secret('forgejo-secrets',{'FORGEJO_URL':'http://forgejo:3000','FORGEJO_PUBLIC_URL':'http://localhost:3001','FORGEJO_OWNER':'revos','FORGEJO_TOKEN':token})
    apply_secret('forgejo-local-login',{'username':'revos','password':password})
    print('Forgejo initialized. Connection and local login stored in Kubernetes secrets.')
for app in ['api','worker']:
    kubectl('set','env','deployment/'+app,'--from=secret/forgejo-secrets')
print('API and worker configured for the private local repository service.')
