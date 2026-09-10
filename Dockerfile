FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates dvb-tools ffmpeg git libdvbcsa-dev libssl-dev pkg-config \
  && git clone https://github.com/gfto/tsdecrypt.git /usr/local/src/tsdecrypt \
  && git -C /usr/local/src/tsdecrypt checkout --detach f4876e84cf1866645f84b93f830af67193c85f69 \
  && git -C /usr/local/src/tsdecrypt config submodule.libfuncs.url https://github.com/gfto/libfuncs.git \
  && git -C /usr/local/src/tsdecrypt config submodule.libtsfuncs.url https://github.com/gfto/libtsfuncs.git \
  && git -C /usr/local/src/tsdecrypt submodule update --init --recursive \
  && make -C /usr/local/src/tsdecrypt \
  && install -m 0755 /usr/local/src/tsdecrypt/tsdecrypt /usr/local/bin/tsdecrypt \
  && install -D -m 0644 /usr/local/src/tsdecrypt/COPYING /usr/local/share/licenses/tsdecrypt/COPYING \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --system astra && useradd --system --gid astra --groups video --home /opt/astra astra
WORKDIR /opt/astra
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.example.json /etc/astra/config.example.json
RUN mkdir -p /var/lib/astra && chown astra:astra /var/lib/astra
USER astra
ENV NODE_ENV=production ASTRA_CONFIG=/var/lib/astra/config.json ASTRA_TSDECRYPT=/usr/local/bin/tsdecrypt
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
EXPOSE 8000/tcp
ENTRYPOINT ["node", "src/server.mjs"]
