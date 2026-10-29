# 鸿蒙能力自检与统一真机验收

当前阶段交付自检工具、验收程序、可修改的场景模板和报告格式。没有连接 Mate 60 Pro 执行这些场景，不宣称真实系统兼容性或权限已验证。

## 安装与构建

本分支需要 Node.js 20.9.0 或更高版本，以及用于设备通信的 HDC。图像处理依赖 sharp 的主机原生包；正常安装应包含 npm optional dependencies。无需在手机上安装额外图像转换程序。

```sh
npm ci
npm run build
npm run audit:platforms:check
```

跨平台 CI 使用 `npm ci --ignore-scripts`；sharp 使用对应操作系统/架构的预编译可选包。不要使用 `--omit=optional`。不支持预编译包的平台需要遵循 [sharp 安装说明](https://sharp.pixelplumbing.com/install/)。

## 能力自检

MCP 调用 `mobile_get_harmony_capabilities`：

```json
{ "device": "harmony:YOUR_DEVICE", "probeReads": false }
```

结果分为以下部分：

| 字段 | 检查内容 | available 的含义 |
|---|---|---|
| connection | 带退出状态的设备 shell 读取 | 此时可完成 shell 读取 |
| metadata | 系统版本、型号、开发者模式原始值 | 参数有返回；developerMode 的值仍可能是 false，不能把该字段 available 当成开发者模式开启 |
| commands | UITest、uinput、bm、aa、hilog、hidumper 等命令 | 命令在设备 shell 中可解析到可执行常规文件 |
| features | text、拖拽、多指、标签、方向、折叠的帮助语法 | 系统声明了对应命令语法，未证明输入权限、硬件或实际效果 |
| permissions | 各读操作和输入/安装/录屏/定位等写操作 | 仅已成功探测的具体读操作，不推断其他操作权限 |
| components | 主机录屏文件、设备定位命令、剪贴板命令 | 文件存在且满足相应静态检查；不证明组件已在设备运行或获得服务授权 |

每一项都有 `state` 和 `evidence`：

- `available`：有该项对应的直接证据。
- `unavailable`：明确检测到缺失、配置无效或明确的权限拒绝。
- `unknown`：尚未执行、无法确定、连接中断或输出无法解析。unknown 不是通过，也不证明系统永久不支持。

默认不调用可能触发输入或更改设备状态的接口。设置 `probeReads: true` 后，会实际读取 UI、截图、应用列表、剪贴板、日志、崩溃列表和前台应用，读取到的内容不写入自检报告。各项独立报告；一次读取成功只证明该次读取。输入、写剪贴板、安装、方向变更、录屏、定位仍标为 unknown。自检不会自动提权、安装组件、触发录屏授权或启动模拟定位。

未连接或 HDC 不可用时，可以对明确的 harmony: ID 获取连接失败的 unknown 报告。不要把“组件文件在电脑上”当作“组件已部署到手机”。

## 统一入口：先校验计划

模板：[acceptance/harmony.template.json](../acceptance/harmony.template.json)。它覆盖基础读取、中文输入、拖拽、双指缩放、组合手势、条件循环和失败后恢复。

模板需要一个受控测试应用，或按现有应用修改它的控件标识、预期文字和坐标。模板中的成功标记必须由应用根据真实操作产生，不能把“命令返回成功”写成通过条件。程序不会自动安装测试应用。`fixture` 字段记录所需初始状态；运行前人工按说明准备。

```sh
mkdir -p acceptance-runs
npm run harmony:accept -- \
  --device harmony:YOUR_DEVICE \
  --config acceptance/harmony.template.json \
  --output acceptance-runs/plan-check
```

不带 `--execute` 时，只检查计划结构、每个工具的参数 schema、设备覆盖规则及必须包含的五类场景。不会发现设备、截图、输入或读取手机。报告 mode 为 plan，status 和全部场景都是 not_run。该模式可以在当前没有手机的阶段执行。

必须包含的分类：basic、chinese、gestures、workflow、recovery。场景 ID 必须唯一；恢复场景必须先出现一个指定的预期错误，再执行至少一个预期成功的操作。禁止在计划步骤覆盖 device，禁止云设备、连接/断开和 batch；流程编排使用有界的 mobile_run_workflow。

## 接手机后执行

先通过普通设备发现取得真实 ID，配置 HDC_PATH，并把模板另存为实际验收计划。确保手机处于计划所需的可复位测试界面。

```sh
npm run harmony:accept -- \
  --device harmony:ACTUAL_DEVICE_ID \
  --config acceptance/my-device.json \
  --output acceptance-runs/device-run-001 \
  --execute
```

`--execute` 会执行计划内的真实操作，可能输入文字、点击、拖拽或更改应用状态。程序先做能力自检，不能确认连接时不执行任何场景。每个工具调用最多等待 6 分钟；工具自身还有各自期限。应使用独占测试设备和无交易副作用的测试应用。

- 非预期错误立即停止，后续场景保持 not_run；已经执行的动作不会回滚。
- `expectError` 必须同时满足 MCP 返回 isError 且文字包含指定内容；其他错误不算通过。传输异常不能冒充预期业务错误。
- 中文和手势场景通过 workflow 的 expect 读取真实界面结果；手势成功后应在应用中有可观察标记。
- Ctrl+C 请求停止后，不再启动下一步；已经发出的同步设备命令仍可能运行到其自身超时，不能将中断当作撤销。
- 输出目录必须新建，位于当前工作目录或系统临时目录的允许范围；拒绝覆盖已有运行目录。

## 结果文件与判定

- `report.json`：时间、计划、设备、自检结果、各步骤结果、预期错误、截图路径及未执行项目。
- `report.md`：场景摘要与人工检查清单。
- 截图文件：按场景/步骤命名，保存真实 PNG/JPEG，并验证 MIME 与图片数据一致。
- 新工具失败时还会返回自己的私有临时诊断路径；原始工具返回内容保存在报告中。

报告每步写入检查点，JSON 用临时文件替换，减少中断时丢失历史。文件可能含测试输入和设备界面，应保留在本地主机；`acceptance-runs/` 默认被 Git 忽略。

| status | 含义 |
|---|---|
| not_run | 仅校验计划，没有实跑 |
| running | 最近检查点仍在执行；若进程已退出则是未完成记录，不是通过 |
| failed | 连接、自检、步骤或中断导致未完成，查看错误与部分记录 |
| needs_manual | 自动场景通过，但仍有人工作业待验收 |
| passed | 该计划自动场景通过，且没有声明人工待验收项；仅证明此次计划覆盖范围 |

模板将断连恢复、录屏实际可播放性和系统权限保留为人工项目，所以自动场景通过后仍为 needs_manual。人工记录应附设备版本、现象和证据，不能用模拟测试或静态组件文件检查代替。

## 实现依据

- [截图缩放](https://sharp.pixelplumbing.com/api-resize/)与[编码参数](https://sharp.pixelplumbing.com/api-output/)在主机处理，PNG 无损，JPEG quality 1–100；输入限制 64 MiB / 64 MP。
- 应用名称采用 [bm dump -a -l](https://github.com/openharmony/bundlemanager_bundle_tool/blob/6a5fea99db7347b8d997fbac3c58f986a9ec8e52/frameworks/src/bundle_command.cpp)；[BMS GetAllBundleLabel](https://github.com/openharmony/bundlemanager_bundle_framework/blob/7865b761797896f384e9465298014cdb541cb73e/services/bundlemgr/src/bundle_mgr_host_impl.cpp)输出 bundleName/label 数组。缺少资源功能时明确回退包名，不把 `$string:` 描述符当显示名称。
- 新增方向键与最近应用键使用 [OpenHarmony KeyEvent 键码](https://github.com/openharmony/multimodalinput_input/blob/7f674c11dee34d4c158827ca8f0e8db3b12a1d4b/frameworks/proxy/events/src/key_event.cpp)，不等于对所有手机控件的响应做了保证。
