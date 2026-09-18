#!/usr/bin/env python3
"""Small Forgejo client for the local OpenHands canvas. Never prints credentials."""
import argparse,json,os,re,subprocess,sys,urllib.request,urllib.error,urllib.parse
BASE='http://host.docker.internal:3001'
PUBLIC='http://localhost:3001'
OWNER='revos'
def repo(value):
    value=value.removeprefix(OWNER+'/')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+',value) or value in ('.','..'):
        raise ValueError('Use a repository name or revos/repository')
    return value
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
def api(path,data=None):
    token=os.environ.get('FORGEJO_TOKEN')
    if not token:raise ValueError('Forgejo credential is not configured in this sandbox')
    request=urllib.request.Request(BASE+'/api/v1'+path,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'token '+token,'Content-Type':'application/json'})
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=30) as r:return json.load(r)
def main():
    p=argparse.ArgumentParser(description='Access local Forgejo without putting tokens in commands. Changes belong on branches for review.')
    sub=p.add_subparsers(dest='command',required=True)
    sub.add_parser('repos',help='List accessible revOS repositories')
    clone=sub.add_parser('clone');clone.add_argument('repository',type=repo);clone.add_argument('directory',nargs='?')
    pr=sub.add_parser('pr');pr.add_argument('repository',type=repo);pr.add_argument('--head',required=True);pr.add_argument('--base',default='main');pr.add_argument('--title',required=True);pr.add_argument('--body-file')
    a=p.parse_args()
    if a.command=='repos':
        page=1
        while True:
            rows=api('/user/repos?limit=50&page='+str(page))
            for r in rows:
                if r['owner']['login']==OWNER:print(json.dumps({'repository':r['full_name'],'description':r.get('description'),'default_branch':r['default_branch'],'url':PUBLIC+'/'+r['full_name'],'clone':PUBLIC+'/'+r['full_name']+'.git'}))
            if len(rows)<50:break
            page+=1
    elif a.command=='clone':
        args=['git','clone',BASE+'/'+OWNER+'/'+a.repository+'.git']
        if a.directory:args+=['--',a.directory]
        subprocess.run(args,check=True)
    elif a.command=='pr':
        body=open(a.body_file).read() if a.body_file else ''
        result=api('/repos/'+OWNER+'/'+a.repository+'/pulls',{'head':a.head,'base':a.base,'title':a.title,'body':body})
        print(json.dumps({'number':result['number'],'url':PUBLIC+'/'+OWNER+'/'+a.repository+'/pulls/'+str(result['number'])}))
if __name__=='__main__':
    try:main()
    except urllib.error.HTTPError as e:
        print('Forgejo request failed: HTTP '+str(e.code),file=sys.stderr);sys.exit(1)
    except (ValueError,subprocess.CalledProcessError,urllib.error.URLError) as e:
        print(str(e),file=sys.stderr);sys.exit(1)
