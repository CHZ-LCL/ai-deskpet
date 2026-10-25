# 把 Git-Gud-AI 立绘做成真·Live2D

> 说明：仓库里的默认桌宠是「单张立绘 + 呼吸/摆动/眨眼」的伪 Live2D。
> 真正的 `.moc3` 必须用 Live2D Cubism Editor（或兼容的 Umamo）绑定骨骼后导出，
> 目前没有可靠的命令行工具能从一张平面图直接生成。

## 素材

| 文件 | 用途 |
| --- | --- |
| `docs/character/front.png` | 正面，主要绑定视图 |
| `docs/character/side.png` | 侧面，`AngleX` 参考 |
| `docs/character/back.png` | 背面，`AngleY` 参考 |
| `assets/default/pet-blink.png` | 闭眼帧，可直接作为 `EyeOpen` 的 0 关键帧 |

三张图都是透明背景、2 倍分辨率；桌面上也有同名文件。

## Cubism Editor 流程

1. **拆层**：在 Photoshop / Krita 里把正面图拆成至少这些层（从后到前）：
   `后发` → `身体` → `后袖` → `脸` → `眼白/瞳孔（左右）` → `上睫毛（左右）` → `眉毛` → `嘴` → `前发` → `前袖`。
   拆不干净也没关系，先保证「头 / 身体 / 左右眼 / 前发 / 手臂」能独立动。
2. **导入 PSD**：Cubism Editor → 新建模型 → 导入 PSD，按图层顺序生成 ArtMesh。
3. **自动网格**：全选 ArtMesh → 自动网格（标准即可），眼睛和嘴可以用更细的网格。
4. **加变形器**：
   - 根变形器 → 身体、头部；
   - 头部下挂 `AngleX` / `AngleY` / `AngleZ`，范围建议 `-30..30`；
   - 眼睛用 `EyeOpen`（0=闭眼，1=睁眼），把 `pet-blink.png` 的闭眼区域贴到 0 帧；
   - 身体挂 `BodyAngleX` / `BodyAngleY`，做轻微呼吸和摆动。
5. **物理**：头发、袖子加物理（Physics），参数名保持默认即可。
6. **导出**：`文件 → 导出 → 嵌入用文件`，勾选 `.moc3`、纹理、`model3.json`、
   `physics3.json`（如果有）。得到一个文件夹，例如 `gitgud/`：
   ```
   gitgud/
   ├─ gitgud.model3.json
   ├─ gitgud.moc3
   ├─ gitgud.2048/texture_00.png
   └─ ...
   ```
7. **接进插件**：
   - 设置 `deskpet.pet.renderer` = `live2d`
   - `deskpet.pet.modelPath` = `gitgud/gitgud.model3.json`（绝对路径或相对工作区）
   - `deskpet.pet.cubismCorePath` = Cubism SDK 里的 `Core/live2dcubismcore.min.js`
   - 或者直接运行 **形象库 → 导入形象**，选择 `.model3.json`（会把整个目录复制到 globalStorage）。

## 动作组命名

插件按候选名匹配动作组，建议在 Cubism 里这样命名：

| 动作 | 建议组名 |
| --- | --- |
| 待机 | `Idle` |
| 点击 / 开心 | `TapBody`、`Happy` |
| 警觉 / 报错 | `Shake`、`Alert` |
| 思考 | `Think` |
| 害羞 | `Shy` |

匹配不到时会退回程序化的呼吸、跳动和摇晃，所以不绑动作也能用。

## 替代方案：Umamo

[Umamo](https://github.com/umamoorg/umamo) 是开源的 Cubism 兼容编辑器，
可以导入/导出 `.cmo3` 和 `.moc3`。它还在早期开发阶段，但如果你不想装 Cubism Editor，
可以试它的桌面版；导入分层 PSD 后按上面的思路绑定，再导出 `.moc3`。

## 注意事项

- 只支持 Cubism 4/5 的 `moc3`；Cubism 2.1 需要另一套 runtime。
- 不要把 `live2dcubismcore.min.js` 或 Live2D 官方示例模型提交到仓库（许可证不允许再分发）。
- 导出的纹理建议控制在 2048px 以内，单个模型 20MB 以内，面板加载会更快。
