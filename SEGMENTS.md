# 分段缓存引擎

`lib/segments.mjs` 提供分镜清单、局部重渲染和整片合成。默认工程是仓库内的 `examples/demo`；使用 `--project` 或 `VIDEO_PROJECT_ROOT` 指向自己的工程。缓存和输出默认写入本工具的 `data`，可通过 `--data-root` 指定其他目录。

## 工程约定

`timeline.json` 是连续的镜头数组，每项包含固定 `id`、`start`、`end`、可选 `title` 和 `kind`。同一连续动画中相邻的相同 `kind` 会归入一个序列，供返修时核对相邻画面。

可选 `review-project.json`：

```json
{
  "version": 1,
  "title": "我的影片",
  "masterVideo": "out/master.mp4",
  "renderAdapter": "render.mjs",
  "width": 1920,
  "height": 1080,
  "fps": 30
}
```

`masterVideo` 默认是 `out/master.mp4`；素材路径必须在工程内。当前分段引擎固定支持 1920×1080、30fps、H.264 High 4.1、无 B 帧、yuv420p、BT.709 limited。基线视频需包含完整音轨，示例使用 AAC。

`renderAdapter` 指向本地 `.mjs` 模块，导出：

```js
export async function renderShot({
  projectRoot, shot, outputPath, fps, width, height, encodingArgs, onProgress
}) {
  // 将 shot.startFrame 到 shot.endFrame（不含）的画面渲染到 outputPath。
  // encodingArgs 是统一的 FFmpeg 视频编码参数；片段本身不带音频。
}
```

适配器是用户信任的本地代码。它需使用全局时间 `globalFrame / fps` 保持跨片段动画连续，生成恰好 `shot.frameCount` 帧。示例适配器见 `examples/demo/render.mjs`。未配置适配器时，引擎使用外部 Lemo-Opuscar 的 `core/render/page.mjs`；通过 `LEMO_OPUSCAR_HOME` 或 `--lib` 指定其安装目录，仓库不捆绑该库。

## 接口

- `loadSegmentManifest(projectRoot, options)`：只读镜头、序列、全局帧边界、依赖版本、可用性和过期状态；初始化前也可调用。
- `initializeSegmentCache(projectRoot, options)`：冻结 `masterVideo`，统一编码一次，再按帧边界切为缓存。来源标记为 `migrated-master`，表示已有成片迁移；它不代表重新渲染或逐像素验证过源码。
- `renderSelectedSegments(projectRoot, {shotIds:[2], ...options})`：必须明确传镜头 ID，通过隔离进程只重画指定片段。返回涉及的连续序列和建议一并检查的镜头；不会自动扩大渲染范围。
- `composeSegments(projectRoot, options)`：核对所有缓存后以流复制拼接画面，复制冻结基线的整条音轨，检查前后音频包 SHA-256 一致；输出到 `data/outputs`，不覆盖已有文件。

镜头帧区间为 `[startFrame,endFrame)`；内部边界取 `ceil(time*30)`，末尾取 `round(duration*30)`。Lemo 截图编码执行一次 JPEG/BT.601 full → BT.709 limited 转换；迁移成片和自定义适配器不套用截图转换。

## 依赖、过期与事务

默认追踪渲染 HTML/JS、时间线、字幕、字体和素材。共享文件变化保守地使所有相关缓存过期；引擎不会从任意函数修改推断其仅影响一个镜头。带明确 `shotId` 和时间范围的 `editor-edits.json` 替换及其素材变化，仅影响对应镜头。独立镜头代码与素材应拆为实际独立的文件，再声明逐镜头依赖。

可选 `segment-dependencies.json`：

```json
{
  "version": 1,
  "shared": ["index.html", "main.js", "timeline.json", "fonts"],
  "shots": {
    "2": {"files": ["assets/shot-02.png"], "revision": 1}
  }
}
```

显式 `shared` 替代默认发现列表，作者负责列全真实共享依赖；配置文件和渲染适配器仍会被追踪。不要移除共享依赖来伪装缓存有效。远程素材仅记录地址，不能独立确认内容是否变化，会显示警告。

文件哈希按路径、大小、修改时间和变更时间缓存；`verifyFreshHash:true` 强制重读源依赖。合成时完整重算缓存文件与冻结基线的指纹。`revision` 只取决于内容依赖和帧边界，缓存可用性与输出路径不会改变工程版本。

一次选段渲染作为一批事务提交：所有选中片段渲染和核验通过后，发布不可变的 `generation-…` 目录，再一次切换 manifest。任何片段失败或提交失败，整批不生效，旧缓存和原成片保留；历史缓存不自动删除。首次迁移采用相同规则。片段 URL 可能包含 generation 子目录，请使用接口返回值。

缺失或过期片段默认阻止合成。底层库支持显式 `allowStaleReuse:true` 并在报告列出这些镜头，但这种结果无法登记为工作台当前预览。渲染或合成过程中内容依赖变化时，拒绝提交过期结果。

## 命令行

```powershell
npm run demo
node scripts/segments.mjs status
node scripts/segments.mjs init
node scripts/segments.mjs render --shots 2
node scripts/segments.mjs compose --output review-v1
```

可选参数：`--project`、`--data-root`、`--lib`、`--query`、`--dependencies`、`--source`、`--output`。Lemo 默认查询参数为 `edits=editor-edits.json`，拒绝缩小的编辑预览模式。

CLI `compose` 成功后再次核对当前版本、片段指纹及输出路径，原子保存 `data/reviews/<projectId>-preview.json`，让工作台加载最新整片；若工程已变化则不登记。刷新工作台即可读取该记录。

标准输出为逐行 JSON 进度及最终 `result`。Windows PowerShell 5 的 `>` 可能写出 UTF-16 日志，读取时需识别 BOM。原始视频、音频和字幕不被覆盖；首次迁移会转码画面，后续合成复用缓存编码，音轨不重新编码。
