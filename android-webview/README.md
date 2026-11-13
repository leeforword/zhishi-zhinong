# 知时智农 · 安卓壳（WebView）

不是 TWA。TWA 本质是"借 Chrome 打开网页"，设备上没有 Chrome 就会退回带地址栏的
Custom Tab。这个壳直接用系统 WebView 渲染站点，跟浏览器没有任何关系。

## 特性

- 全屏无地址栏，返回键先退网页再退应用
- 站内链接留在壳里，站外链接交给系统浏览器
- 请求定位时自动授权（高德地图选点用得到）
- 断网显示原生兜底页，可一键重试
- 包名沿用 `io.github.leeforword.twa`，用同一把 keystore 签名，可以直接覆盖安装

## 构建（不需要 Gradle、不需要 Android Studio）

前提：本机有 Android SDK（build-tools 34 + platform android-34）和一个 JDK。

```bash
bash android-webview/build.sh
```

脚本流程：`aapt2 compile → aapt2 link → javac → d8 → zip 加 dex → zipalign → apksigner`。
产物：`android-webview/build/zhishi-zhinong-webview.apk`

签名用的是 PWABuilder 生成的 `signing.keystore`（桌面「知时智农 - Google Play package」
目录），密码从同目录 `signing-key-info.txt` 读取，不写进仓库。

## 改站点地址

`src/io/github/leeforword/shell/MainActivity.java` 顶部的 `START` 与 `HOST`。
