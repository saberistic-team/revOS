"""End-to-end workspace checks against a running local engine. --live-assistant calls OpenAI on synthetic fixtures."""
import json,urllib.request,urllib.error,time,sys,uuid,os
BASE=os.environ.get('API_URL','http://localhost:3000')
def api(path,body=None,expected=200):
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=40) as r: status=r.status;data=json.load(r)
    except urllib.error.HTTPError as e:status=e.code;data=json.load(e)
    if expected!=status:raise AssertionError((path,status,data))
    return data
def state():return api('/workspace/'+ORG+'/state')
def wait(job):
    for _ in range(150):
        j=next(j for j in state()['jobs'] if j['id']==job['id'])
        if j['state'] in ['completed','failed']:return j
        time.sleep(2)
    raise AssertionError('Job timed out')
def approve(c,confirm=False):return wait(api('/workspace/'+ORG+'/changes/'+c['id']+'/approve',{'confirmKnowledge':confirm}))
def capture(content,target=None,rev=0):return api('/workspace/'+ORG+'/capture',{'documentId':target,'baseRevision':rev,'reason':'Synthetic verification fixture','body':{'title':'Synthetic customer profile','category':'business','content':content,'evidence':'unverified','relatedIds':[]}})
ORG=api('/builder/organizations',{'name':'Workspace verification '+str(uuid.uuid4())[:8]})['id'];open('/tmp/workspace-verification-org','w').write(ORG);open('/tmp/workspace-test-orgs','a').write(ORG+'\n')
agent=api('/builder/agents',{'organizationId':ORG,'name':'Fixture agent','instructions':'Analyze synthetic data only.'})
skill=api('/builder/skills',{'organizationId':ORG,'name':'Fixture analysis','description':'Analyze supplied synthetic customer notes.','instructions':'Summarize supplied customer notes and list unknowns.','inputSchema':{'type':'object'},'outputSchema':{'type':'object'},'configuration':{'allowedToolIds':[],'allowedKnowledgeIds':[]}})
c=capture('Our synthetic customer serves small software companies.');assert approve(c)['state']=='completed';doc=state()['documents'][0];assert doc['fileSha'] and doc['commitSha'];assert doc['revision']==1
print('PASS capture → approval → Temporal → private Forgejo commit → library index',flush=True)
a=capture('Our synthetic customer serves consultancies.',doc['id'],1);b=capture('Outdated competing correction.',doc['id'],1)
assert approve(a,True)['state']=='completed';failed=approve(b);assert failed['state']=='failed' and 'revision conflict' in failed['error'];doc=state()['documents'][0];assert doc['revision']==2 and doc['evidence']=='customer_confirmed'
print('PASS stale corrections rejected; confirmed version retained',flush=True)
api('/builder/knowledge',{'id':doc['id'],'organizationId':ORG,'name':'Bypass','content':'Should not overwrite repository'},409)
other=next(o for o in api('/builder/catalog')['organizations'] if o['id']!=ORG)
api('/workspace/'+other['id']+'/capture',{'documentId':doc['id'],'baseRevision':2,'reason':'Cross-org negative test','body':{'title':'Bad','category':'notes','content':'Blocked','evidence':'unverified','relatedIds':[]}},400)
repo=api('/workspace/'+ORG+'/repository');assert repo['exists'] and len(repo['commits'])>=2
print('PASS organization isolation, direct-edit protection, repository history',flush=True)
if '--live-assistant' in sys.argv:
    prompts = [
        ('knowledge', 'Correct the selected synthetic profile to say it serves consultancies with 10–50 employees, preserving the rest. Return one knowledge proposal.', {'documentId':doc['id']}),
        ('library', 'Create a new workflow called Synthetic discovery check using the existing Fixture analysis skill, then a human review step. It takes customer notes as input and returns a summary. Also propose an independent new skill called Synthetic meeting summarizer to summarize supplied notes with no tools or knowledge. The new skill is not a dependency of the workflow. Use the supplied agent and existing skill version IDs. Return two proposals.', {}),
    ]
    proposals=[]
    for scope,prompt,selection in prompts:
        thread=api('/workspace/'+ORG+'/threads',{'title':'Synthetic '+scope+' verification','scope':scope})
        j=api('/workspace/'+ORG+'/threads/'+thread['id']+'/messages',{'content':prompt,**selection});finished=wait(j);assert finished['state']=='completed',finished
        answer=api('/workspace/'+ORG+'/threads/'+thread['id'])['messages'][-1];assert not answer['metadata']['proposalErrors'],answer['metadata']
        proposals.extend(c for c in state()['changes'] if c['id'] in answer['metadata']['proposalIds'])
    assert {p['kind'] for p in proposals}=={'knowledge','workflow','skill'}
    for c in proposals:assert approve(c)['state']=='completed'
    s=state();assert any(w['name']=='Synthetic discovery check' for w in s['workflows']);assert any(k['name']=='Synthetic meeting summarizer' for k in s['skills'])
    print('PASS live Agents SDK produces valid knowledge correction, workflow draft, and new skill; approved updates apply',flush=True)
print('Verification organization:',ORG,flush=True)
