#!/usr/bin/env bash
# Generate certs/ so the page is served over HTTPS. getUserMedia refuses to run
# on a plain-HTTP page that isn't localhost, and your phone is never localhost.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p certs

# Best guess at this machine's LAN address — the cert has to name it.
LAN_IP="${LAN_IP:-$(
  (ipconfig getifaddr en0 2>/dev/null) ||
  (hostname -I 2>/dev/null | awk '{print $1}') ||
  echo ""
)}"

if [ -z "$LAN_IP" ]; then
  echo "Couldn't work out your LAN IP. Re-run as: LAN_IP=192.168.x.x ./make-certs.sh"
  exit 1
fi

echo "Using LAN address: $LAN_IP"

if command -v mkcert >/dev/null 2>&1; then
  # mkcert is the path that actually works on iOS: it installs a local CA you
  # can trust on the phone, so Safari stops refusing the camera.
  mkcert -install
  mkcert -key-file certs/key.pem -cert-file certs/cert.pem "$LAN_IP" localhost 127.0.0.1
  echo
  echo "Done. On the phone, install the root CA from:"
  echo "  $(mkcert -CAROOT)/rootCA.pem"
  echo "AirDrop or email it to yourself, install the profile, then turn it on under"
  echo "Settings > General > About > Certificate Trust Settings."
else
  echo "mkcert not found — falling back to a self-signed cert."
  echo "Safari on iOS may still refuse the camera on an untrusted cert."
  echo "If it does, install mkcert (brew install mkcert) and run this again."
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "/CN=$LAN_IP" \
    -addext "subjectAltName=IP:$LAN_IP,IP:127.0.0.1,DNS:localhost"
fi

echo
echo "Now run: npm start   →   https://$LAN_IP:${PORT:-3000}"
