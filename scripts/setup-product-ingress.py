#!/usr/bin/env python3
"""Install a local controller for a single synthetic product namespace only.

This does not install the separately approved CI runner/delivery credentials or
operator permissions. New product namespaces require explicit routing enrollment.
"""
import argparse,json,pathlib,re,subprocess
ROOT=pathlib.Path(__file__).resolve().parent.parent

def main():
 p=argparse.ArgumentParser();p.add_argument('--namespace',required=True);a=p.parse_args()
 if not re.fullmatch(r'product-[a-f0-9-]{36}-(preview|live)',a.namespace):raise SystemExit('Use a product environment namespace')
 k=['kubectl','--context','docker-desktop']
 def apply(s):subprocess.run(k+['apply','-f','-'],input=s,text=True,check=True)
 apply(json.dumps({'apiVersion':'v1','kind':'Namespace','metadata':{'name':'product-ingress-system'}}))
 apply((ROOT/'infrastructure/kubernetes/product-runtime/ingress-rbac.yaml').read_text().replace('FIXTURE_NAMESPACE',a.namespace))
 subprocess.run(['helm','upgrade','--install','product-ingress','oci://ghcr.io/traefik/helm/traefik','--version','41.6.0','--namespace','product-ingress-system','--kube-context','docker-desktop','--skip-crds','-f',str(ROOT/'infrastructure/kubernetes/product-runtime/traefik-values.yaml'),'--set','providers.kubernetesIngress.namespaces[0]='+a.namespace],check=True)
 print('Local product ingress installed. Forward localhost3006 to service/product-ingress-traefik:80; configure publicPort3006.')
if __name__=='__main__':main()
