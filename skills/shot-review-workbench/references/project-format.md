# 工程接入

工作台仓库：https://github.com/beta7716/shot-review-workbench

## 最小目录

```text
my-film/
├── review-project.json
├── timeline.json
├── render.mjs
├── segment-dependencies.json
├── shots/
│   ├── shot-001.mjs
│   └── shot-002.mjs
└── out/
    └── master.mp4
```

`out/master.mp4` 是已确认整片及原音轨基线，不是可编辑源码的替代品。源工程和素材保留在工程目录；工作台批注、上传文件、缓存和新输出写入数据目录。

## review-project.json

```json
{
  "version": 1,
  "title": "我的影片 · 分镜批注",
  "masterVideo": "out/master.mp4",
  "renderAdapter": "render.mjs"
}
```

`masterVideo`、`renderAdapter` 使用工程内相对路径，不允许越界。`renderAdapter` 可省略；此时源码渲染需要另行配置兼容的 Lemo-Opuscar 库。当前缓存编码固定 1920×1080、30fps；不要用其他尺寸或帧率冒充兼容工程。

适配器是本机执行的 Node.js 模块，须先检查。它导出：

```javascript
export async function renderShot({
  projectRoot, shot, outputPath, fps, width, height, encodingArgs, onProgress
}) {
  // 用 shot.startFrame / fps 作为全局起点。
  // 渲染 shot.frameCount 帧到 outputPath，使用传入的 encodingArgs。
  // 返回前等待编码器完成；失败时抛错，不提交半成品。
}
```

具体可运行实现见仓库 `examples/demo`。保持全局时间，即使仅渲染一镜也不要从零重置连续动画。`outputPath` 由引擎提供，输出必须匹配固定编码规范；引擎会验证尺寸、帧数及缓存指纹。

## timeline.json

```json
[
  { "id": 1, "start": 0, "end": 3, "title": "问题出现", "kind": "opening" },
  { "id": 2, "start": 3, "end": 6, "title": "操作与结果", "kind": "demo" }
]
```

时间单位为秒，镜头必须连续、无重叠，ID 是正整数且唯一。内部边界按 `ceil(秒×30)` 换算，最后一帧边界取 `round(总秒数×30)`；使用 `[startFrame,endFrame)`，结束帧不包含在该镜头中。尽量按整帧填写时间。`kind` 用于提示连续序列，不等于任意源码改动的精确影响范围。

## 缓存与依赖

```json
{
  "version": 1,
  "shared": ["review-project.json", "timeline.json", "render.mjs"],
  "shots": {
    "1": { "files": ["shots/shot-001.mjs"], "revision": 1 },
    "2": { "files": ["shots/shot-002.mjs"], "revision": 1 }
  }
}
```

显式 `shared` 会覆盖自动发现列表，必须列全实际共享依赖。单镜头专用源码或素材列在该镜头的 `files`；共享脚本变化会使其关联缓存过期。不要为了避免重渲染而省略真实依赖。远程素材不能仅凭地址保证内容未变化，制作时优先归档获准使用的本地素材。

首次迁移命令：

```powershell
node scripts/segments.mjs init --project "<工程目录>"
```

它冻结整片并切分缓存，不重新绘制源码。新工程也可在准备好基线后显式渲染所有镜头，再合成；原音轨仍来自冻结基线。

## 启动与切换

在工作台仓库运行：

```powershell
$env:VIDEO_PROJECT_ROOT = '<工程绝对路径>'
$env:VIDEO_REVIEW_DATA_ROOT = '<数据绝对路径>'
$env:PORT = '4318'
npm start
```

打开终端显示的本机地址。默认端口 4318；如果被占用，换用空闲端口，不接管另一个工程的服务。数据目录可以留空使用工作台默认 `data`，但保留独立目录更便于迁移与备份。服务重启后正在执行的任务记录不会恢复，应检查输出和缓存状态再重试。
