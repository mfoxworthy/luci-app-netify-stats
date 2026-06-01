#!/bin/sh
# Cross-build the luci-app-netify-stats .apk via the OpenWrt SDK luci feed.
set -e
HOST="${NSP_BUILD_HOST:-mfoxworthy@10.0.4.220}"
REMOTE="${NSP_LUCI_REMOTE:-/home/mfoxworthy/luci-app-netify-stats-build}"
SDK="${NSP_SDK_DIR:-/home/mfoxworthy/openwrt}"
PKG="$SDK/feeds/luci/applications/luci-app-netify-stats"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

rsync -az --delete --exclude '.git/' --exclude 'scripts/' "$HERE"/ "$HOST:$REMOTE"/
ssh -o BatchMode=yes "$HOST" "
  set -e
  rm -rf '$PKG'; mkdir -p '$PKG'
  rsync -a --exclude '.git' '$REMOTE'/ '$PKG'/
  ln -sfn '$PKG' '$SDK/package/feeds/luci/luci-app-netify-stats'
  grep -q '^CONFIG_PACKAGE_luci-app-netify-stats=' '$SDK/.config' || echo 'CONFIG_PACKAGE_luci-app-netify-stats=m' >> '$SDK/.config'
  cd '$SDK'; make defconfig >/dev/null 2>&1
  timeout \${NSP_BUILD_TIMEOUT:-420} make package/feeds/luci/luci-app-netify-stats/{clean,compile} V=s 2>&1 | tail -40
  echo '>> built:'; find '$SDK/bin' -name 'luci-app-netify-stats*.apk' -o -name 'luci-app-netify-stats*.ipk' 2>/dev/null
"
