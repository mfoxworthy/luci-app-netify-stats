# luci-app-netify-stats

LuCI statistics views for [netify-plugin-stats](../netify-plugin-stats). Adds two stacked-area Chart.js pages under **Statistics** in the LuCI web UI:

- **Netify Overview** — per-application traffic (`apps` dimension)
- **Netify Categories** — per-category traffic (`cats` dimension)

Both views support 1h / 1d / 30d time ranges, rx/tx bytes, packets, and flows metrics. The 1h view live-polls every 10 seconds.

## Requirements

- OpenWrt 25.12+ with `netify-plugin-stats` installed and `luci.netify-stats` ubus object live
- `luci-base`, `rpcd`
- Build host with the OpenWrt SDK (`~/openwrt`) and `luci` feed present

## Run transform unit tests

```sh
./scripts/test-transform.sh
```

Runs `tests/run.js` with Node locally if available, otherwise rsync + ssh to the build host (`$NSP_BUILD_HOST`, default `mfoxworthy@10.0.4.220`).

Expected output: `transform: 11 checks passed`

## Build

```sh
./scripts/sdk-build.sh
```

Stages the package into `$SDK/feeds/luci/applications/luci-app-netify-stats`, symlinks it into `package/feeds/luci/`, and cross-builds the `.apk`. Output lands at:

```
$SDK/bin/packages/arm_cortex-a7_neon-vfpv4/luci/luci-app-netify-stats-0.apk
```

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `NSP_BUILD_HOST` | `mfoxworthy@10.0.4.220` | SSH target for build host |
| `NSP_LUCI_REMOTE` | `/home/mfoxworthy/luci-app-netify-stats-build` | Staging dir on build host |
| `NSP_SDK_DIR` | `/home/mfoxworthy/openwrt` | SDK root on build host |
| `NSP_BUILD_TIMEOUT` | `420` | Build timeout in seconds |

## Install on router

```sh
# Build host -> Mac
scp mfoxworthy@10.0.4.220:<apk-path> /tmp/luci-app-netify-stats.apk

# Mac -> router (scp -O required for dropbear compatibility)
scp -O /tmp/luci-app-netify-stats.apk root@10.0.4.1:/tmp/

# Install and restart services
ssh root@10.0.4.1 'apk add --allow-untrusted /tmp/luci-app-netify-stats.apk && \
  /etc/init.d/rpcd restart && /etc/init.d/uhttpd restart'
```

## Views

- `http://10.0.4.1/cgi-bin/luci/admin/statistics/netify_overview`
- `http://10.0.4.1/cgi-bin/luci/admin/statistics/netify_categories`

## LuCI runtime notes (resolved during on-device verification)

**Resource module path:** `chart.js` (the shared renderer) must live at `htdocs/luci-static/resources/netify-stats/chart.js` and be required as `'require netify-stats.chart as chart'`. Placing it under `view/` causes a 404 because LuCI resolves dot-separated paths relative to `resources/`, not `resources/view/`.

**Module export:** Non-view resource modules must return a `baseclass.extend({...})` result. Returning a plain object `{}` causes a "factory yields invalid constructor" error from the LuCI module loader.
