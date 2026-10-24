# 默认形象 / 音效

把随插件一起分发的素材放在这里，打包后自动生效，**不需要改任何代码**。

## 默认形象

当前随包附带 `pet.png`（一张金属水管的透明贴纸，横版）。放一张图片即可替换：

```
assets/default/pet.png     // png / jpg / gif / webp / svg 都支持
```

- 建议：透明背景，**1000px 以上**；横版、竖版、方形都可以。
- 插件会读取图片实际宽高比来决定展示尺寸：横版会自动加宽舞台并把更多空间让给对话区。
- 动图（GIF/WebP）同样可用，动作（跳动、摇晃）会作用在整张图上。
- 删掉这个文件就回到内置的 SVG 小豆（矢量、自带眨眼/摆尾动画）。

## 默认音效

放到上一级目录 `assets/sounds/`，文件名固定为槽位名：

```
assets/sounds/click.mp3    // 已附带：金属管敲击声
assets/sounds/happy.mp3
assets/sounds/alert.mp3
assets/sounds/error.mp3
assets/sounds/switch.mp3
```

没有对应文件时，插件会用 WebAudio 合成一个提示音，所以空着也能用。

## 换成 Live2D / 3D

模型文件体积大，不建议直接塞进插件包。推荐走「形象库 → 导入形象」，
文件会被复制到插件的 globalStorage，并在设置里自动指向它。
