#!/usr/bin/env bash
# 手工打包 WebView 壳（不用 Gradle）：aapt2 → javac → d8 → zipalign → apksigner
set -e
cd "$(dirname "$0")/.."

JDK_DIR=$(find .build -maxdepth 1 -type d -name "jdk-*" | head -1)
if [ -z "$JDK_DIR" ]; then echo "找不到 JDK，先解压 .build/jdk.zip"; exit 1; fi
export JAVA_HOME="$(cd "$JDK_DIR" && pwd)"
export PATH="$JAVA_HOME/bin:$PATH"

SDK="${LOCALAPPDATA:-$HOME/AppData/Local}/Android/Sdk"
BT="$SDK/build-tools/34.0.0"
AJ="$SDK/platforms/android-34/android.jar"
[ -f "$AJ" ] || { echo "缺少 android-34/android.jar"; exit 1; }

OUT="android-webview/build"
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "1/6 aapt2 compile"
"$BT/aapt2.exe" compile --dir android-webview/res -o "$OUT/res.zip"

echo "2/6 aapt2 link"
"$BT/aapt2.exe" link -o "$OUT/app.apk" -I "$AJ" \
  --manifest android-webview/AndroidManifest.xml \
  -R "$OUT/res.zip" --java "$OUT/gen" --auto-add-overlay

echo "3/6 javac"
find android-webview/src "$OUT/gen" -name "*.java" > "$OUT/sources.txt"
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$AJ" -cp "$AJ" -d "$OUT/classes" @"$OUT/sources.txt"

echo "4/6 d8"
find "$OUT/classes" -name "*.class" > "$OUT/classes.txt"
"$BT/d8.bat" --release --lib "$AJ" --min-api 23 --output "$OUT/dex" @"$OUT/classes.txt"

echo "5/6 打包 dex 并对齐"
python - "$OUT" <<'PY'
import sys, zipfile, shutil, os
out = sys.argv[1]
src = os.path.join(out, 'app.apk')
dst = os.path.join(out, 'app-dex.apk')
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(out, 'dex', 'classes.dex'), 'classes.dex')
print('dex 已写入')
PY
"$BT/zipalign.exe" -f -p 4 "$OUT/app-dex.apk" "$OUT/app-aligned.apk"

echo "6/6 签名"
KS="/c/Users/axiom/Desktop/知时智农 - Google Play package/signing.keystore"
INFO="/c/Users/axiom/Desktop/知时智农 - Google Play package/signing-key-info.txt"
PASS=$(grep -m1 "Key store password" "$INFO" | sed 's/.*: //' | tr -d '\r')
"$BT/apksigner.bat" sign --ks "$KS" --ks-key-alias my-key-alias \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$OUT/zhishi-zhinong-webview.apk" "$OUT/app-aligned.apk"

"$BT/apksigner.bat" verify --print-certs "$OUT/zhishi-zhinong-webview.apk" | head -5
ls -lh "$OUT/zhishi-zhinong-webview.apk"
