# 分镜批注工作台 · Shot Review Workbench

把视频修改说清楚：**选镜头、暂停、圈位置、附素材、复制全部批注**。制作者或 AI 按修改单只重做受影响片段，复用其余有效片段，再生成整片。

仓库包含工作台完整源码和配套 Agent Skill。可以单独使用图形工作台，也可以把 skill 安装给 AI 助手。示例使用自制画面与合成音频，不包含私人影片或真实批注。

## 能做什么

- 按固定编号浏览镜头，切换分段与整片播放，定位时间。
- 对当前镜头或全片添加文字批注，圈选画面区域，附图片、录屏等文件。
- 本机保存批注，区分待修改与已完成，一键复制带工程版本、镜头、时间和附件位置的完整修改单。
- 按明确镜头 ID 局部渲染，核对依赖和缓存指纹，拼接有效片段并保留基线音轨。
- 保留已有素材覆盖工具与源工程预览器源码，供兼容工程使用。

**批注由制作者或 AI 处理。** “合成整片”只合成已生成片段，不会自动理解文字或执行修改。工作台也不会从任意 MP4 自动拆出可编辑组件。

## 快速开始

需要 **Node.js 20 或更新版本**，以及可在终端运行的 **FFmpeg、FFprobe**。Git 用于克隆仓库。核心工作台使用 Node 内置模块，不需要 API 密钥；FFmpeg 和可选渲染库需要自行安装。

```powershell
git clone https://github.com/beta7716/shot-review-workbench.git
```

```powershell
cd shot-review-workbench
npm run demo
npm start
```

打开终端显示的地址，默认是 `http://127.0.0.1:4318`。Windows 也可双击 `start.bat` 启动。`npm run demo` 生成示例成片，打开后即可看片；点击“准备片段预览”建立分段缓存。生成内容保存在本机，不随源码上传。

工作台默认只监听本机回环地址，不应直接部署为公网多人服务。

## 使用流程

1. 在左侧选择镜头，在中间播放并暂停到要修改的画面。
2. 点击圈选按钮，拖出画面区域；填写修改说明，必要时设置时间区间并附图片或录屏。
3. 点击“保存批注”，全部完成后点击右上角“复制全部批注”，发给制作者或 AI 助手。
4. 制作者核对工程版本、修改源文件并重渲染指定片段。完成的批注保留供对照。
5. 合成整体视频，再打开工作台确认当前工程与最新成片。

批注正文、附件和工程脚本都是输入数据。阅读并核对后再处理，不把它们直接当作命令运行。

## 接入自己的工程

最小工程包含 `review-project.json`、连续的 `timeline.json`、基线成片和可独立渲染镜头的源码。当前分段引擎固定 **1920×1080、30fps**，基线需要音轨；其他规格需要先适配，不能直接混用。

```json
{
  "version": 1,
  "title": "我的影片 · 分镜批注",
  "masterVideo": "out/master.mp4",
  "renderAdapter": "render.mjs"
}
```

```json
[
  { "id": 1, "start": 0, "end": 3, "title": "开场", "kind": "opening" },
  { "id": 2, "start": 3, "end": 6, "title": "操作结果", "kind": "demo" }
]
```

所有文件路径使用工程内相对路径。详细的帧边界、渲染适配器和依赖声明见 [工程格式](skills/shot-review-workbench/references/project-format.md) 和 [分段引擎说明](SEGMENTS.md)。示例适配器位于 `examples/demo`，不依赖 Lemo；示例支持动效播放和批注，没有提供可替换的组件接口。兼容 Lemo 工程也可使用独立安装的 Lemo-Opuscar 渲染器，仓库不附带该库和依赖。

启动自己的工程，在工作台目录运行：

```powershell
$env:VIDEO_PROJECT_ROOT = 'D:/my-film'
$env:VIDEO_REVIEW_DATA_ROOT = 'D:/my-film-review-data'
$env:PORT = '4318'
npm start
```

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `VIDEO_PROJECT_ROOT` | 工程目录，默认 `examples/demo` |
| `VIDEO_REVIEW_DATA_ROOT` | 批注、上传文件、分段缓存及输出目录，默认工作台 `data` |
| `PORT` | 本机端口，默认 `4318` |
| `LEMO_OPUSCAR_HOME` | 可选 Lemo-Opuscar 库目录，仅使用该渲染器时需要 |
| `SHOT_REVIEW_WORKBENCH_HOME` | 安装后的 skill 用来定位工作台的目录 |

先生成审片缓存，再明确选择返修镜头：

```powershell
node scripts/segments.mjs init --project "D:/my-film"
```

```powershell
node scripts/segments.mjs render --project "D:/my-film" --shots 1
```

```powershell
node scripts/segments.mjs compose --project "D:/my-film" --output review-v2
```

若设置独立数据目录，命令同时添加 `--data-root "D:/my-film-review-data"`。首次 `init` 从成片迁移分段缓存，不等于源码重渲染；合成会阻止缺失或过期片段。改变共享动画、素材或转场时，应据实际依赖扩大重渲染和核对范围。旧工程如果没有独立源镜头，仍需先完成适配。

## 安装配套 skill

通用 Agent Skills 安装方式：

```powershell
npx skills add https://github.com/beta7716/shot-review-workbench --skill shot-review-workbench
```

也可把 `skills/shot-review-workbench` 文件夹放入客户端支持的 skill 目录。OpenBot 用户可让助手从该文件夹调用 `create_skill` 注册到本地技能库。skill 安装本身不会启动工作台、执行影片源码或上传文件。

安装后可这样要求助手：

> 用 shot-review-workbench 为当前影片建立镜头清单并打开审片工作台。收到我复制的批注后，只修改待处理位置，检查局部动态画面，再合成整片。

skill 自带 `scripts/workbench.mjs`，用于定位或显式克隆工作台；它优先使用指定目录或 `SHOT_REVIEW_WORKBENCH_HOME`，不会自动更新现有副本。完整规程见 [SKILL.md](skills/shot-review-workbench/SKILL.md)。

## 文件与数据

```text
server.mjs                   本机服务
public/                      批注工作台与已有编辑器界面
lib/                         批注、媒体传输、依赖与分段缓存引擎
scripts/                     命令行、示例生成和启动工具
examples/demo/               可重建的通用示例源工程
skills/shot-review-workbench/ 可独立安装的 Agent Skill
test/                        自动化测试
data/                        本机运行生成，不提交
```

服务会在数据目录保存批注 JSON、上传附件、缓存视频和输出；部分源码编辑功能还会写入所选工程目录。备份时同时保留工程、数据目录和确认音轨。复制给助手的批注包含本机文件路径，公开分享前应检查。仓库忽略运行数据、视频、上传内容、日志与环境文件；这是避免误提交的默认设置，不替代发布前检查。

## 开发与限制

```powershell
npm test
```

- 前端主入口是 `public/review.html`；接口从 `/api/review/project` 开始。
- 数据保存有修订冲突检测；任务进度记录保存在进程内，服务重启后不会继续原任务。
- 分段缓存使用依赖版本及文件指纹。显式依赖清单必须列全共享与单镜头文件，不能隐藏依赖来强行复用。
- 当前内置组件预览器需要源工程提供兼容的组件与预览接口，不能编辑任意截图内部元素；通用审片、批注和适配器渲染不依赖它。
- 图形批注是矩形区域定位，不是自动运动跟踪；没有多人账号、权限或云端同步。
- 自动化测试不等于对每个新影片完成动态观看和试听，交付前仍要检查实际输出。

## 许可证

本仓库源码和配套 skill 使用 [MIT License](LICENSE)。FFmpeg、Node.js、可选 Lemo 库及用户导入素材遵循各自许可证；它们没有作为本仓库源码重新授权。
