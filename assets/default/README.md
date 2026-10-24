# 默认形象 / 音效

把随插件一起分发的素材放在这里，打包后自动生效，**不需要改任何代码**。

## 默认立绘

在 `default/` 下放一张图片即可（文件名随意，多张时取目录里的第一张）：

```
assets/default/pet.png     // png / jpg / gif / webp / svg 都支持
```

- 建议：竖构图，透明背景，**1000×1000 以上**，主体居中对齐底部。
- 动图（GIF/WebP）同样可用。
- 放了默认立绘后，「内置形象」会自动改用它；删除文件即回到内置矢量形象。

## 默认音效

放到上一级目录 `assets/sounds/`，文件名固定为槽位名：

```
assets/sounds/click.mp3
assets/sounds/happy.mp3
assets/sounds/alert.mp3
assets/sounds/error.mp3
assets/sounds/switch.mp3
```

没有对应文件时，插件会用 WebAudio 合成一个提示音，所以空着也能用。

## 换成 Live2D / 3D

模型文件体积大，不建议直接塞进插件包。推荐走「形象库 → 导入形象」，
文件会被复制到插件的 globalStorage，并在设置里自动指向它。
