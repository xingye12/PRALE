FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils findutils grep sed gawk git ripgrep python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep", "infinity"]
