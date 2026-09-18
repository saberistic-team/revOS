#!/usr/bin/env python3
"""Git credential protocol: return token only for the configured local Forgejo."""
import os,sys
if len(sys.argv)<2 or sys.argv[1]!='get':sys.exit(0)
fields=dict(line.rstrip('\n').split('=',1) for line in sys.stdin if '=' in line)
if fields.get('protocol')=='http' and fields.get('host')=='host.docker.internal:3001':
    token=os.environ.get('FORGEJO_TOKEN')
    if token:print('username=revos\npassword='+token+'\n')
