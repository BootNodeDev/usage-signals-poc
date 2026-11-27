#!/usr/bin/env bash
set -euo pipefail

version=8.30.1
bin_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)/bin
stamp="$bin_dir/.gitleaks-version"

[ -x "$bin_dir/gitleaks" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$version" ] && exit 0

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  darwin | linux) ;;
  *)
    echo "install-gitleaks: unsupported OS '$os'" >&2
    exit 1
    ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *)
    echo "install-gitleaks: unsupported architecture '$arch'" >&2
    exit 1
    ;;
esac

base="https://github.com/gitleaks/gitleaks/releases/download/v${version}"
tarball="gitleaks_${version}_${os}_${arch}.tar.gz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
curl -fsSL -o "$tmp/checksums.txt" "$base/gitleaks_${version}_checksums.txt"
(cd "$tmp" && grep " ${tarball}\$" checksums.txt | shasum -a 256 -c -)

mkdir -p "$bin_dir"
tar -xzf "$tmp/$tarball" -C "$bin_dir" gitleaks
echo "$version" >"$stamp"
echo "install-gitleaks: gitleaks ${version} installed at $bin_dir/gitleaks"
