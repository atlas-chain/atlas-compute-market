#!/bin/sh
# Atlas Compute Market — one-line provider join.
#
#   curl -fsSL https://compute-market.arkiv-global.net/join.sh | sh
#
# Downloads the self-contained provider agent (atlas-vm-driver) and runs it.
# The agent boots a Golem VM (ya-runtime-vm, no network inside), benchmarks
# this host, registers, and keeps the offer alive with heartbeats until you
# stop it with Ctrl-C. The runtime and VM image are fetched by the agent on
# first run and cached under ~/.cache/atlas-vm-driver.
#
# Tunables (env vars):
#   CPU_CORES=4          logical cores to offer   (also sizes the VM)
#   MEM_GIB=8            RAM in GiB to offer       (also sizes the VM)
#   DISPLAY_NAME=my-node human-readable label in the market
#   ATLAS_MARKET=URL     registry to join (default: this site)
#   ATLAS_BIN_DIR=DIR    where to install the agent (default: ~/.atlas)
# Anything after `--` is passed straight to the agent (e.g. `-- --once`).
set -eu

MARKET="${ATLAS_MARKET:-https://compute-market.arkiv-global.net}"
CPU_CORES="${CPU_CORES:-4}"
MEM_GIB="${MEM_GIB:-8}"
DISPLAY_NAME="${DISPLAY_NAME:-}"
BIN_DIR="${ATLAS_BIN_DIR:-${HOME:-.}/.atlas}"
ASSET="atlas-vm-driver-x86_64-linux"
DRIVER="$BIN_DIR/atlas-vm-driver"

if [ -t 1 ]; then C='\033[1;36m'; R='\033[1;31m'; Z='\033[0m'; else C=''; R=''; Z=''; fi
say() { printf "%b==>%b %s\n" "$C" "$Z" "$*"; }
die() { printf "%berror:%b %s\n" "$R" "$Z" "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
[ "$(uname -s)" = "Linux" ]  || die "the provider runtime needs Linux (found $(uname -s))"
[ "$(uname -m)" = "x86_64" ] || die "this build is x86_64 only (found $(uname -m))"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required (the agent unpacks the VM runtime with it)"
[ -e /dev/kvm ] || die "/dev/kvm not found — enable virtualization (KVM) on this host"
{ [ -r /dev/kvm ] && [ -w /dev/kvm ]; } || \
  die "no access to /dev/kvm — add your user to the kvm group:\n    sudo usermod -aG kvm \"\$USER\"   # then log out and back in"

# --- download the agent ------------------------------------------------------
mkdir -p "$BIN_DIR"
say "downloading provider agent from $MARKET"
curl -fSL "$MARKET/dl/$ASSET" -o "$DRIVER.tmp" || die "download failed"

if command -v sha256sum >/dev/null 2>&1; then
  want=$(curl -fsSL "$MARKET/dl/$ASSET.sha256" 2>/dev/null | awk '{print $1}') || true
  if [ -n "${want:-}" ]; then
    got=$(sha256sum "$DRIVER.tmp" | awk '{print $1}')
    [ "$want" = "$got" ] || { rm -f "$DRIVER.tmp"; die "checksum mismatch (expected $want, got $got)"; }
    say "checksum ok ($got)"
  fi
fi

chmod +x "$DRIVER.tmp"
mv -f "$DRIVER.tmp" "$DRIVER"
say "installed $DRIVER"

# --- run it ------------------------------------------------------------------
say "joining $MARKET as a provider — $CPU_CORES cores, $MEM_GIB GiB (Ctrl-C to stop)"
# argv = base flags, optional display name, then any caller args ("$@" from
# `sh -s -- …`). "$@" on the RHS expands to the caller args before `set` rebinds.
if [ -n "$DISPLAY_NAME" ]; then
  set -- --base-url "$MARKET" --cpu-cores "$CPU_CORES" --mem-gib "$MEM_GIB" --env "DISPLAY_NAME=$DISPLAY_NAME" "$@"
else
  set -- --base-url "$MARKET" --cpu-cores "$CPU_CORES" --mem-gib "$MEM_GIB" "$@"
fi
exec "$DRIVER" "$@"
