FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl nodejs npm && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir openhands-sdk==1.49.1 openhands-tools==1.49.1
RUN useradd -m -u 1000 agent
COPY apps/openhands/build.py apps/openhands/progress.py /opt/
USER agent
WORKDIR /workspace
CMD ["python","/opt/build.py"]
