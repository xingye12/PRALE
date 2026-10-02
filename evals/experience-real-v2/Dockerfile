ARG BASE_IMAGE
FROM ${BASE_IMAGE}

WORKDIR /opt/pi
COPY source.tar /tmp/source.tar
RUN tar -xf /tmp/source.tar -C /opt/pi \
    && rm /tmp/source.tar \
    && npm ci --ignore-scripts \
    && npm run build

ENV CI=true
