FROM node:22-bookworm-slim
COPY patches/tsdecrypt-emm-pid.patch patches/tsdecrypt-ecm-protection.patch patches/tsdecrypt-stream-io.patch patches/tsdecrypt-cw-threadsafe.patch patches/tsdecrypt-pes-validation.patch /tmp/astra-native-patches/
COPY test/native-ecm-policy.c test/native-cas-io.c test/native-pes-validation.c /tmp/astra-native-tests/
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates dvb-tools ffmpeg git libdvbcsa-dev libssl-dev pkg-config \
  && git clone https://github.com/gfto/tsdecrypt.git /usr/local/src/tsdecrypt \
  && git -C /usr/local/src/tsdecrypt checkout --detach f4876e84cf1866645f84b93f830af67193c85f69 \
  && git -C /usr/local/src/tsdecrypt config submodule.libfuncs.url https://github.com/gfto/libfuncs.git \
  && git -C /usr/local/src/tsdecrypt config submodule.libtsfuncs.url https://github.com/gfto/libtsfuncs.git \
  && git -C /usr/local/src/tsdecrypt submodule update --init --recursive \
  && for patch in tsdecrypt-emm-pid.patch tsdecrypt-ecm-protection.patch tsdecrypt-stream-io.patch tsdecrypt-cw-threadsafe.patch tsdecrypt-pes-validation.patch; do \
       git -C /usr/local/src/tsdecrypt apply --check "/tmp/astra-native-patches/$patch" \
       && git -C /usr/local/src/tsdecrypt apply "/tmp/astra-native-patches/$patch" || exit 1; \
     done \
  && for fixture in native-ecm-policy native-cas-io native-pes-validation; do \
       cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I /usr/local/src/tsdecrypt "/tmp/astra-native-tests/$fixture.c" -o "/tmp/astra-native-tests/$fixture-test" \
       && "/tmp/astra-native-tests/$fixture-test" || exit 1; \
     done \
  && make -C /usr/local/src/tsdecrypt \
  && install -m 0755 /usr/local/src/tsdecrypt/tsdecrypt /usr/local/bin/tsdecrypt \
  && install -D -m 0644 /usr/local/src/tsdecrypt/COPYING /usr/local/share/licenses/tsdecrypt/COPYING \
  && install -m 0644 /tmp/astra-native-patches/*.patch /usr/local/share/licenses/tsdecrypt/ \
  && install -m 0644 /tmp/astra-native-patches/tsdecrypt-emm-pid.patch /usr/local/share/licenses/tsdecrypt/astra-emm-pid.patch \
  && install -m 0644 /tmp/astra-native-patches/tsdecrypt-ecm-protection.patch /usr/local/share/licenses/tsdecrypt/astra-ecm-protection.patch \
  && node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const hash=data=>crypto.createHash("sha256").update(data).digest("hex"); const names=["tsdecrypt-emm-pid.patch","tsdecrypt-ecm-protection.patch","tsdecrypt-stream-io.patch","tsdecrypt-cw-threadsafe.patch","tsdecrypt-pes-validation.patch"]; const digests=names.map(name=>hash(fs.readFileSync("/tmp/astra-native-patches/"+name))); fs.writeFileSync("/usr/local/share/licenses/tsdecrypt/astra-native-cas.json",JSON.stringify({policyVersion:3,sourceRevision:"f4876e84cf1866645f84b93f830af67193c85f69",binarySha256:hash(fs.readFileSync("/usr/local/bin/tsdecrypt")),patchSetSha256:hash(digests.join("\n")+"\n"),sourceDirectory:"/usr/local/src/tsdecrypt",buildTarget:"ffdecsa",patches:{ecm:digests[1],streamIO:digests[2],controlWords:digests[3],pesValidation:digests[4]}})+"\n",{mode:0o644});' \
  && git clone https://git.streamboard.tv/common/oscam.git /usr/local/src/oscam \
  && git -C /usr/local/src/oscam checkout --detach 39e78a4688b30abaab62b5c9e13672b4e34bfca0 \
  && cd /usr/local/src/oscam \
  && ./config.sh --disable all --enable MODULE_NEWCAMD READER_NAGRA READER_NAGRA_MERLIN READER_IRDETO READER_CONAX READER_CRYPTOWORKS READER_SECA READER_VIACCESS READER_VIDEOGUARD READER_DRE READER_TONGFANG READER_BULCRYPT READER_GRIFFIN READER_DGCRYPT \
  && make OSCAM_BIN=Distribution/oscam \
  && install -m 0755 Distribution/oscam /usr/local/bin/oscam \
  && install -D -m 0644 COPYING /usr/local/share/licenses/oscam/COPYING \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --system astra && useradd --system --gid astra --groups video --home /opt/astra astra
WORKDIR /opt/astra
COPY package.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin
RUN cc -shared -fPIC -O2 -Wall -Wextra bin/dvb-buffer.c -o bin/dvb-buffer.so -ldl \
  && node --input-type=module -e 'import { protectedNativeBuild } from "./src/softcam.mjs"; if (!protectedNativeBuild()) process.exit(1);'
COPY config.example.json /etc/astra/config.example.json
RUN mkdir -p /var/lib/astra && chown astra:astra /var/lib/astra
USER astra
ENV NODE_ENV=production ASTRA_CONFIG=/var/lib/astra/config.json ASTRA_TSDECRYPT=/usr/local/bin/tsdecrypt ASTRA_OSCAM=/usr/local/bin/oscam
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
EXPOSE 8000/tcp
ENTRYPOINT ["node", "src/server.mjs"]
