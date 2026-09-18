"""Run inside the OpenHands web container; preserve session history and credentials."""
import sys,json,io,tarfile,docker
from pydantic import SecretStr
from openhands.sdk.utils.cipher import Cipher
name,conversation=sys.argv[1:3]
client=docker.from_env();c=client.containers.get(name);c.reload();attrs=c.attrs
config=attrs['Config'];env=dict(v.split('=',1) for v in config['Env'])
key=env.get('OH_SECRET_KEY') or env.get('SESSION_API_KEY') or env.get('OH_SESSION_API_KEYS_0')
if not key:raise RuntimeError('No session encryption key; refusing to modify state')
folder='/workspace/conversations/'+conversation.replace('-','')
stream,_=c.get_archive(folder+'/base_state.json');raw=b''.join(stream)
with tarfile.open(fileobj=io.BytesIO(raw)) as t:
 member=t.getmembers()[0];state=json.load(t.extractfile(member))
if state.get('execution_status') not in ('idle','error','finished','paused'):raise RuntimeError('Conversation is active; refusing to interrupt work')
cipher=Cipher(key);encrypted=state['agent'].get('encrypted_mcp_config');plain=cipher.decrypt(encrypted)
if plain is None:raise RuntimeError('Cannot decrypt saved MCP config')
mcp=json.loads(plain.get_secret_value());servers=mcp.get('mcpServers',{})
found=False
for server in servers.values():
 if server.get('url')=='http://localhost:3003/mcp/mcp':server['url']='http://host.docker.internal:3003/mcp/mcp';found=True
if not found:raise RuntimeError('Expected stale MCP endpoint not found')
state['agent']['encrypted_mcp_config']=cipher.encrypt(SecretStr(json.dumps(mcp)))
c.stop(timeout=15)
backup=name+'-network-backup'
try:
 data=json.dumps(state).encode();out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w') as t:
  old=tarfile.TarInfo('base_state.network-backup.tar');old.size=len(raw);old.mode=0o600;old.uid=member.uid;old.gid=member.gid;t.addfile(old,io.BytesIO(raw))
  updated=tarfile.TarInfo('base_state.json');updated.size=len(data);updated.mode=member.mode;updated.uid=member.uid;updated.gid=member.gid;t.addfile(updated,io.BytesIO(data))
 c.put_archive(folder,out.getvalue())
 env['OH_WEBHOOKS_0_BASE_URL']='http://host.docker.internal:3003/api/v1/webhooks'
 c.rename(backup)
 created=client.api.create_container(image=config['Image'],name=name,command=config.get('Cmd'),entrypoint=config.get('Entrypoint'),environment=env,host_config=attrs['HostConfig'],working_dir=config.get('WorkingDir'),user=config.get('User'),labels=config.get('Labels'),volumes=config.get('Volumes'),detach=True)
 client.api.start(created['Id'])
 print('Repaired MCP and callback addresses; conversation ID, workspace, history, credentials, and ports preserved. Backup container remains stopped.')
except Exception:
 try:
  replacement=client.containers.get(name)
  if replacement.id!=c.id:replacement.remove(force=True)
 except docker.errors.NotFound:pass
 c.rename(name);c.put_archive(folder,raw);c.start();raise
