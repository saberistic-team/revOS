#!/usr/bin/env python3
"""Kelos custom Task image protocol; repository/Kubernetes credentials stay outside."""
import json
import os
import pathlib
import pwd
import subprocess
import sys
from build import main

def normalize_environment():
    # revOS mounts an existing UID1000 workspace; Kelos images default to61100.
    # Respect the actual task UID so an inaccessible image-user home in PATH
    # cannot turn an absent optional executable into PermissionError.
    home = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir)
    os.environ['HOME'] = str(home)
    local_bin = home / '.local' / 'bin'
    local_bin.mkdir(parents=True, exist_ok=True)
    paths = [str(local_bin), *os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin').split(os.pathsep)]
    os.environ['PATH'] = os.pathsep.join(dict.fromkeys(p for p in paths if p and os.path.isdir(p) and os.access(p, os.X_OK)))


def entrypoint():
    normalize_environment()
    setup = os.environ.get('KELOS_SETUP_COMMAND')
    if setup:
        command = json.loads(setup)
        if not isinstance(command, list) or not command or any(not isinstance(s, str) for s in command):
            raise ValueError('Invalid Kelos setup command')
        subprocess.run(command, check=True)
    if os.environ.get('KELOS_SESSION_SETUP_ONLY') == '1':
        raise ValueError('This OpenHands adapter implements Kelos Tasks; persistent state is retained on the revOS build PVC, not the Kelos Session protocol')
    if len(sys.argv) != 2:
        raise ValueError('Kelos must supply its task prompt')
    root = pathlib.Path('/workspace')
    request = json.loads((root / 'request.json').read_text())
    if request['id'] not in sys.argv[1]:
        raise ValueError('Kelos prompt does not match the mounted build')
    if os.environ.get('KELOS_MODEL'):
        os.environ['OPENHANDS_MODEL'] = os.environ['KELOS_MODEL']
    try:
        main(root)
    finally:
        result_file = root / 'result.json'
        if result_file.exists():
            result = json.loads(result_file.read_text())
            print('---KELOS_OUTPUTS_START---')
            print('revos-build: ' + request['id'])
            print('state: ' + result.get('state', 'failed'))
            usage = result.get('usage') or {}
            for key, field in [('input-tokens', 'inputTokens'), ('output-tokens', 'outputTokens')]:
                if isinstance(usage.get(field), int):
                    print(key + ': ' + str(usage[field]))
            print('---KELOS_OUTPUTS_END---')

if __name__ == '__main__':
    entrypoint()
