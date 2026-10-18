FROM node:22-bookworm-slim
COPY patches/tsdecrypt-emm-pid.patch patches/tsdecrypt-ecm-protection.patch patches/tsdecrypt-stream-io.patch patches/tsdecrypt-cw-threadsafe.patch patches/tsdecrypt-pes-validation.patch patches/tsdecrypt-newcamd-lifetime.patch patches/tsdecrypt-ciphertext-safety.patch /tmp/astra-native-patches/
COPY test/native-ecm-policy.c test/native-cas-io.c test/native-pes-validation.c test/native-ciphertext-safety.c test/native-ciphertext-probe.c /tmp/astra-native-tests/
COPY patches/oscam-newcamd-stream-io.patch patches/oscam-semantic-scheduler.patch /tmp/astra-oscam-patches/
COPY test/native-oscam-io.c test/native-oscam-scheduler.c /tmp/astra-oscam-tests/
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates dvb-tools ffmpeg git libdvbcsa-dev libssl-dev pkg-config util-linux \
  && git clone https://github.com/gfto/tsdecrypt.git /usr/local/src/tsdecrypt \
  && git -C /usr/local/src/tsdecrypt checkout --detach f4876e84cf1866645f84b93f830af67193c85f69 \
  && git -C /usr/local/src/tsdecrypt config submodule.libfuncs.url https://github.com/gfto/libfuncs.git \
  && git -C /usr/local/src/tsdecrypt config submodule.libtsfuncs.url https://github.com/gfto/libtsfuncs.git \
  && git -C /usr/local/src/tsdecrypt submodule update --init --recursive \
  && for patch in tsdecrypt-emm-pid.patch tsdecrypt-ecm-protection.patch tsdecrypt-stream-io.patch tsdecrypt-cw-threadsafe.patch tsdecrypt-pes-validation.patch tsdecrypt-newcamd-lifetime.patch tsdecrypt-ciphertext-safety.patch; do \
       git -C /usr/local/src/tsdecrypt apply --check "/tmp/astra-native-patches/$patch" \
       && git -C /usr/local/src/tsdecrypt apply "/tmp/astra-native-patches/$patch" || exit 1; \
     done \
  && for fixture in native-ecm-policy native-cas-io native-pes-validation native-ciphertext-safety; do \
       cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I /usr/local/src/tsdecrypt "/tmp/astra-native-tests/$fixture.c" -o "/tmp/astra-native-tests/$fixture-test" \
       && "/tmp/astra-native-tests/$fixture-test" || exit 1; \
     done \
  && cc -std=c11 -Wall -Wextra -Werror -O2 -I /usr/local/src/tsdecrypt /tmp/astra-native-tests/native-ciphertext-probe.c /usr/local/src/tsdecrypt/astra-ciphertext-probe.c -ldvbcsa -o /tmp/astra-native-tests/native-ciphertext-probe-test \
  && /tmp/astra-native-tests/native-ciphertext-probe-test \
  && make -C /usr/local/src/tsdecrypt \
  && install -m 0755 /usr/local/src/tsdecrypt/tsdecrypt /usr/local/bin/tsdecrypt \
  && install -D -m 0644 /usr/local/src/tsdecrypt/COPYING /usr/local/share/licenses/tsdecrypt/COPYING \
  && install -m 0644 /tmp/astra-native-patches/*.patch /usr/local/share/licenses/tsdecrypt/ \
  && install -m 0644 /tmp/astra-native-patches/tsdecrypt-emm-pid.patch /usr/local/share/licenses/tsdecrypt/astra-emm-pid.patch \
  && install -m 0644 /tmp/astra-native-patches/tsdecrypt-ecm-protection.patch /usr/local/share/licenses/tsdecrypt/astra-ecm-protection.patch \
  && node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const hash=data=>crypto.createHash("sha256").update(data).digest("hex"); const names=["tsdecrypt-emm-pid.patch","tsdecrypt-ecm-protection.patch","tsdecrypt-stream-io.patch","tsdecrypt-cw-threadsafe.patch","tsdecrypt-pes-validation.patch","tsdecrypt-newcamd-lifetime.patch","tsdecrypt-ciphertext-safety.patch"]; const digests=names.map(name=>hash(fs.readFileSync("/tmp/astra-native-patches/"+name))); fs.writeFileSync("/usr/local/share/licenses/tsdecrypt/astra-native-cas.json",JSON.stringify({policyVersion:10,sourceRevision:"f4876e84cf1866645f84b93f830af67193c85f69",binarySha256:hash(fs.readFileSync("/usr/local/bin/tsdecrypt")),patchSetSha256:hash(digests.join("\n")+"\n"),sourceDirectory:"/usr/local/src/tsdecrypt",buildTarget:"ffdecsa",patches:{ecm:digests[1],streamIO:digests[2],controlWords:digests[3],pesValidation:digests[4],newcamdLifetime:digests[5],ciphertextSafety:digests[6]}})+"\n",{mode:0o644});' \
  && git clone https://git.streamboard.tv/common/oscam.git /usr/local/src/oscam \
  && git -C /usr/local/src/oscam checkout --detach 39e78a4688b30abaab62b5c9e13672b4e34bfca0 \
  && git -C /usr/local/src/oscam apply --check /tmp/astra-oscam-patches/oscam-newcamd-stream-io.patch \
  && git -C /usr/local/src/oscam apply /tmp/astra-oscam-patches/oscam-newcamd-stream-io.patch \
  && git -C /usr/local/src/oscam apply --check /tmp/astra-oscam-patches/oscam-semantic-scheduler.patch \
  && git -C /usr/local/src/oscam apply /tmp/astra-oscam-patches/oscam-semantic-scheduler.patch \
  && cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I /usr/local/src/oscam /tmp/astra-oscam-tests/native-oscam-io.c -o /tmp/astra-oscam-tests/native-oscam-io-test \
  && /tmp/astra-oscam-tests/native-oscam-io-test \
  && cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I /usr/local/src/oscam /tmp/astra-oscam-tests/native-oscam-scheduler.c -o /tmp/astra-oscam-tests/native-oscam-scheduler-test \
  && /tmp/astra-oscam-tests/native-oscam-scheduler-test \
  && cd /usr/local/src/oscam \
  && ./config.sh --disable all --enable MODULE_NEWCAMD READER_NAGRA READER_NAGRA_MERLIN READER_IRDETO READER_CONAX READER_CRYPTOWORKS READER_SECA READER_VIACCESS READER_VIDEOGUARD READER_DRE READER_TONGFANG READER_BULCRYPT READER_GRIFFIN READER_DGCRYPT \
  && make OSCAM_BIN=Distribution/oscam \
  && install -m 0755 Distribution/oscam /usr/local/bin/oscam \
  && install -D -m 0644 COPYING /usr/local/share/licenses/oscam/COPYING \
  && install -m 0644 /tmp/astra-oscam-patches/oscam-newcamd-stream-io.patch /usr/local/share/licenses/oscam/ \
  && install -m 0644 /tmp/astra-oscam-patches/oscam-semantic-scheduler.patch /usr/local/share/licenses/oscam/ \
  && node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const hash=path=>crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");fs.writeFileSync("/usr/local/share/licenses/oscam/astra-native-oscam.json",JSON.stringify({policyVersion:4,semanticPolicyVersion:4,sourceRevision:"39e78a4688b30abaab62b5c9e13672b4e34bfca0",binarySha256:hash("/usr/local/bin/oscam"),patchSha256:hash("/tmp/astra-oscam-patches/oscam-newcamd-stream-io.patch"),semanticSchedulerSha256:hash("/tmp/astra-oscam-patches/oscam-semantic-scheduler.patch"),sourceDirectory:"/usr/local/src/oscam"})+"\n",{mode:0o644});' \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --system astra && useradd --system --gid astra --groups video --home /opt/astra astra
WORKDIR /opt/astra
COPY package.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin
RUN cc -shared -fPIC -O2 -Wall -Wextra bin/dvb-buffer.c -o bin/dvb-buffer.so -ldl \
  && bash bin/build-media-tcp.sh \
  && node --input-type=module -e 'import { protectedNativeBuild } from "./src/softcam.mjs"; import { protectedOscamBuild } from "./src/oscam-integrity.mjs"; if (!protectedNativeBuild() || !protectedOscamBuild()) process.exit(1);'
COPY config.example.json /etc/astra/config.example.json
RUN mkdir -p /var/lib/astra && chown astra:astra /var/lib/astra
USER astra
ENV NODE_ENV=production ASTRA_CONFIG=/var/lib/astra/config.json ASTRA_TSDECRYPT=/usr/local/bin/tsdecrypt ASTRA_OSCAM=/usr/local/bin/oscam
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
EXPOSE 8000/tcp
ENTRYPOINT ["node", "src/server.mjs"]
