#!/bin/sh
# Builds the three packages into tweak/packages:
#   iphoneos-arm     rootful
#   iphoneos-arm64   rootless
#   iphoneos-arm64e  roothide (rootless dylib, installed at / paths)
# Each dylib holds arm64 and arm64e code. Run ../build.sh first (or let it
# call this script) so polyfill.h and smfix.h exist.
set -e
cd "$(dirname "$0")"
: "${THEOS:?Set THEOS to your Theos folder}"
rm -rf .theos packages
make package FINALPACKAGE=1
rm -rf .theos/obj
make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless
V=$(sed -n 's/^Version: //p' control); P=$(sed -n 's/^Package: //p' control)
W=$(mktemp -d)
dpkg-deb -x "packages/${P}_${V}_iphoneos-arm64.deb" "$W/rl"
mkdir -p "$W/rh/DEBIAN" "$W/rh/Library/MobileSubstrate/DynamicLibraries"
cp "$W"/rl/var/jb/Library/MobileSubstrate/DynamicLibraries/SafariModernizer.* "$W/rh/Library/MobileSubstrate/DynamicLibraries/"
mkdir -p "$W/rh/usr/share" && cp -R "$W/rl/var/jb/usr/share/doc" "$W/rh/usr/share/"
sed 's/^Architecture: .*/Architecture: iphoneos-arm64e/' control > "$W/rh/DEBIAN/control"
"$THEOS/bin/dm.pl" -Zxz -z9 -b "$W/rh" "packages/${P}_${V}_iphoneos-arm64e.deb"
rm -rf "$W"
ls packages
