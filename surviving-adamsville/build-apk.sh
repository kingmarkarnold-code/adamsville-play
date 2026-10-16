#!/bin/bash
# Build Surviving Adamsville Demo APK (manual aapt2/d8 pipeline, per voice-companion BUILD_NOTES.md)
set -e
export JAVA_HOME=~/workspace/.jdk/jdk17
export PATH=$JAVA_HOME/bin:$PATH
SDK=~/workspace/.android-sdk
BT=$SDK/build-tools/34.0.0
PROJ=~/workspace/game-map/project
STAGE=~/workspace/game-map/project/stage
KS=~/workspace/goals/free-voice-ai-companion/build/debug.keystore

rm -rf "$STAGE"
mkdir -p "$STAGE/assets/www" "$STAGE/classes" "$STAGE/dex"
cp -r "$PROJ/www/"* "$STAGE/assets/www/"

# 1. compile resources (launcher icons) + link -> unsigned APK
$BT/aapt2 compile --dir "$PROJ/app/src/main/res" -o "$STAGE/res.zip"
$BT/aapt2 link -o "$STAGE/app-unsigned.apk" \
  --manifest "$PROJ/app/src/main/AndroidManifest.xml" \
  -A "$STAGE/assets" \
  -R "$STAGE/res.zip" \
  -I "$SDK/platforms/android-34/android.jar" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code 10 --version-name 1.0

# 2. compile java
javac -encoding UTF-8 -source 17 -target 17 \
  -cp "$SDK/platforms/android-34/android.jar" \
  -d "$STAGE/classes" \
  "$PROJ/app/src/main/java/com/joshua/survivingadamsville/"*.java

# 3. dex
$BT/d8 --min-api 26 --lib "$SDK/platforms/android-34/android.jar" \
  --output "$STAGE/dex" "$STAGE/classes/com/joshua/survivingadamsville/"*.class

# 4. add classes.dex at APK root
cp "$STAGE/app-unsigned.apk" "$STAGE/app-dex.apk"
(cd "$STAGE/dex" && zip -X ../app-dex.apk classes.dex)

# 5. align
$BT/zipalign -f 4 "$STAGE/app-dex.apk" "$STAGE/app-aligned.apk"

# 6. sign
$BT/apksigner sign --ks "$KS" --ks-pass pass:android \
  --key-pass pass:android --out "$STAGE/surviving-adamsville-demo.apk" "$STAGE/app-aligned.apk"

# 7. verify
echo "=== badging ==="
$BT/aapt dump badging "$STAGE/surviving-adamsville-demo.apk" | grep -E "package:|sdkVersion|targetSdkVersion|application:|launchable"
echo "=== apksigner verify ==="
$BT/apksigner verify --print-certs "$STAGE/surviving-adamsville-demo.apk" | head -5

mkdir -p ~/workspace/game-map/build
cp "$STAGE/surviving-adamsville-demo.apk" ~/workspace/game-map/build/surviving-adamsville-demo.apk
ls -la ~/workspace/game-map/build/surviving-adamsville-demo.apk
echo BUILD_OK
