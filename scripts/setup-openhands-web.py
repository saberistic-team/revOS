"""Expose Docker's Unix socket to the existing kind node and deploy the canvas.
Local Docker Desktop only; intentionally grants OpenHands Docker control.
No TCP Docker API, cluster recreation, or credentials in this script.
"""
import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
node='desktop-worker'
def run(args,**kw):return subprocess.run(args,check=True,**kw)
node_info=json.loads(subprocess.check_output(['docker','inspect',node]))[0]
volume=next(m['Name'] for m in node_info['Mounts'] if m['Destination']=='/var' and m['Type']=='volume')
run(['docker','exec',node,'sh','-c','mkdir -p /var/lib/revos-docker && chmod 700 /var/lib/revos-docker'])
existing=subprocess.run(['docker','inspect','revos-docker-socket'],capture_output=True)
if existing.returncode:
 run(['docker','run','-d','--name','revos-docker-socket','--restart','unless-stopped','--network','none','--mount','type=bind,src=/var/run/docker.sock,dst=/upstream.sock','--mount',f'type=volume,src={volume},dst=/socket,volume-subpath=lib/revos-docker','alpine/socat:1.8.0.3','UNIX-LISTEN:/socket/docker.sock,fork,unlink-early,mode=0600','UNIX-CONNECT:/upstream.sock'])
else:
 relay=json.loads(existing.stdout)[0]
 if not any(m.get('Name')==volume and m['Destination']=='/socket' for m in relay['Mounts']):
  raise SystemExit('Node volume changed; replace the old socket relay explicitly before continuing.')
 run(['docker','start','revos-docker-socket'],stdout=subprocess.DEVNULL)
run(['kubectl','--context','docker-desktop','-n','agent-engine-local','apply','-f',str(root/'infrastructure/kubernetes/local/openhands-web.yaml')])
print('OpenHands is deployed in Kubernetes. Open localhost:3003 using:')
print('kubectl --context docker-desktop -n agent-engine-local port-forward service/openhands-web 3003:3000')
