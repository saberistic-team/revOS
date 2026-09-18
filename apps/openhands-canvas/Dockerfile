FROM ghcr.io/openhands/agent-server:1.27.0-python
USER root
COPY apps/openhands-canvas/forgejo.py /usr/local/bin/forgejo
COPY apps/openhands-canvas/credential.py /usr/local/bin/forgejo-credential
RUN chmod 755 /usr/local/bin/forgejo /usr/local/bin/forgejo-credential \
 && git config --system credential.helper /usr/local/bin/forgejo-credential \
 && git config --system url.http://host.docker.internal:3001/.insteadOf http://localhost:3001/ \
 && git config --system user.name 'OpenHands' \
 && git config --system user.email 'openhands@localhost.invalid'
USER openhands
