import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("public portal deployment imports only approved keys and excludes future shared secrets", () => {
  const script = `import ast,copy,json,subprocess\np=ast.parse(open(${JSON.stringify(resolve(__dirname, "../scripts/deploy-platform-preview.py"))}).read())\nfn=next(n for n in p.body if isinstance(n,ast.FunctionDef) and n.name=='portal_environment')\nfn.args.defaults=[]\nmodule=ast.Module(body=[fn],type_ignores=[])\nscope={'copy':copy,'subprocess':subprocess}\nexec(compile(ast.fix_missing_locations(module),'portal-env','exec'),scope)\nresources={('secret','shared'):{'data':{'DATABASE_URL':'private-db','OPENAI_API_KEY':'private-openai','FORGEJO_TOKEN':'private-forgejo','FUTURE_PROVIDER_SECRET':'future'}},('configmap','config'):{'data':{'TEMPORAL_ADDRESS':'temporal','FORGEJO_TOKEN':'misplaced-secret','TEMPORAL_TASK_QUEUE':'old-queue'}}}\ncontainer={'envFrom':[{'secretRef':{'name':'shared'}},{'configMapRef':{'name':'config'}}],'env':[{'name':'FORGEJO_TOKEN','value':'direct-private-token'},{'name':'OPENAI_API_KEY','valueFrom':{'secretKeyRef':{'name':'other','key':'key'}}},{'name':'CUSTOMER_PORTAL_ONLY','value':'true'},{'name':'TEMPORAL_TASK_QUEUE','value':'agent-engine-platform'}]}\nprint(json.dumps(scope['portal_environment'](container,lambda kind,name:resources[(kind,name)])))`;
  const result = JSON.parse(
    execFileSync("python3", ["-c", script], { encoding: "utf8" }),
  );
  assert.equal(result.envFrom, undefined);
  const names = result.env.map((v: any) => v.name);
  assert.deepEqual(names.sort(), [
    "CUSTOMER_PORTAL_ONLY",
    "DATABASE_URL",
    "TEMPORAL_ADDRESS",
    "TEMPORAL_TASK_QUEUE",
  ]);
  assert.equal(
    result.env.find((v: any) => v.name === "TEMPORAL_TASK_QUEUE").value,
    "agent-engine-platform",
  );
  assert.equal(
    result.env.find((v: any) => v.name === "DATABASE_URL").valueFrom
      .secretKeyRef.name,
    "shared",
  );
  assert(!JSON.stringify(result).includes("private-"));
  assert(!JSON.stringify(result).includes("FORGEJO"));
  assert(!JSON.stringify(result).includes("OPENAI"));
  assert(!JSON.stringify(result).includes("FUTURE"));
});
